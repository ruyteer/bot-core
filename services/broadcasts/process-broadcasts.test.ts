import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { processDueBroadcasts } from "./application/process-broadcasts.use-case.js";
import { testDb } from "../../test/helpers/db.js";
import { scheduledMessages, broadcastRuns, payments, leads, funnelOffers, botGroups } from "../shared/schema/index.js";
import { createBot, createLead, createGateway } from "../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls, forceTelegramError } from "../../test/helpers/fetch-mock.js";

async function seedMsg(botId: string, userId: string, over: Partial<typeof scheduledMessages.$inferInsert> = {}) {
  const db = await testDb();
  const [row] = await db.insert(scheduledMessages).values({
    userId, botId, botIds: [botId], message: "Oi {nome}!",
    broadcastType: "instant", filterType: "all", targetType: "leads", targetGroupIds: [],
    scheduledAt: new Date(Date.now() - 1000), status: "pending", ...over,
  }).returning();
  return row;
}

describe("processDueBroadcasts", () => {
  it("envia a mensagem aos leads, interpola {nome}, marca sent e cria broadcast_run", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5001n); // firstName "Lead"
    const msg = await seedMsg(bot.id, bot.userId);

    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    expect(getSentMessages()).toContain("Oi Lead!");

    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("sent");
    expect(after.sentAt).toBeInstanceOf(Date);
    const runs = await db.select().from(broadcastRuns);
    expect(runs.length).toBe(1);
    expect(runs[0].sentCount).toBe(1);
    expect(runs[0].failedCount).toBe(0);
  });

  it("não reenvia um broadcast já enviado (idempotência via claim)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5002n);
    await seedMsg(bot.id, bot.userId);
    await processDueBroadcasts();
    const n2 = await processDueBroadcasts(); // nada pendente
    expect(n2).toBe(0);
    expect(getSentMessages().filter((m) => m === "Oi Lead!").length).toBe(1);
  });

  it("filterType 'buyers' só envia para quem comprou", async () => {
    const bot = await createBot();
    const gw = await createGateway({ userId: bot.userId });
    const buyer = await createLead(bot.id, 5003n);
    await createLead(bot.id, 5004n); // não comprador
    const db = await testDb();
    await db.insert(payments).values({ userId: bot.userId, botId: bot.id, leadId: buyer, gatewayId: gw, amount: 1000, status: "paid" });
    await seedMsg(bot.id, bot.userId, { filterType: "buyers", message: "promo" });

    await processDueBroadcasts();
    // só 1 envio (o comprador)
    expect(getTelegramCalls("sendMessage").length).toBe(1);
  });

  it("recorrência diária reagenda (status pending + scheduledAt futuro)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5005n);
    const msg = await seedMsg(bot.id, bot.userId, {
      broadcastType: "recurring",
      recurrenceRule: { freq: "daily", time: "09:00", tz: "America/Sao_Paulo" } as unknown as Record<string, unknown>,
    });
    await processDueBroadcasts();
    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("pending");
    expect(after.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect(after.recurrenceCount).toBe(1);
  });

  it("recorrência com max 1 ocorrência → completed", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5006n);
    const msg = await seedMsg(bot.id, bot.userId, {
      broadcastType: "recurring", recurrenceMaxOccurrences: 1,
      recurrenceRule: { freq: "daily", time: "09:00" } as unknown as Record<string, unknown>,
    });
    await processDueBroadcasts();
    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("completed");
  });
});

describe("processDueBroadcasts — status real (fix)", () => {
  it("falha no Telegram marca 'failed', não 'sent'", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5007n);
    const msg = await seedMsg(bot.id, bot.userId, { message: "oi" });
    forceTelegramError("sendMessage");
    await processDueBroadcasts();
    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("failed");
    const runs = await db.select().from(broadcastRuns);
    expect(runs[0].failedCount).toBe(1);
    expect(runs[0].sentCount).toBe(0);
  });

  it("mensagem vazia sem mídia não conta alvo (totalTargets 0)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5008n);
    await seedMsg(bot.id, bot.userId, { message: "" });
    await processDueBroadcasts();
    const db = await testDb();
    const runs = await db.select().from(broadcastRuns);
    expect(runs[0].totalTargets).toBe(0);
  });
});

describe("processDueBroadcasts — não envia para grupos (bug João)", () => {
  it("broadcast 'leads' ignora chats de grupo/canal (id negativo)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 7001n);     // usuário real
    await createLead(bot.id, -1001500n); // grupo resíduo (id negativo)
    await seedMsg(bot.id, bot.userId, { message: "promo", filterType: "all", targetType: "leads" });
    await processDueBroadcasts();
    expect(getTelegramCalls("sendMessage").length).toBe(1); // só o usuário recebe
  });
});

describe("processDueBroadcasts — targetGroupIds inválido (bug offer_style-like: chat_id no lugar do uuid)", () => {
  it("targetGroupIds com valor não-uuid é descartado, não derruba o broadcast nem vira 'todos os grupos'", async () => {
    const bot = await createBot();
    const db = await testDb();
    await db.insert(botGroups).values({ botId: bot.id, name: "Canal real", telegramChatId: -1004316952477n, type: "channel" });
    await seedMsg(bot.id, bot.userId, {
      message: "promo", targetType: "groups", targetGroupIds: ["-1004347875198"], // chat_id, não uuid — o bug relatado
    });

    const n = await processDueBroadcasts();
    expect(n).toBe(1); // processou sem lançar

    // Não manda pro canal real (que existe) — o filtro inválido não pode virar "sem filtro = todos".
    expect(getTelegramCalls("sendMessage").length).toBe(0);
    const runs = await db.select().from(broadcastRuns);
    expect(runs[0].totalTargets).toBe(0);
    expect(runs[0].status).toBe("completed"); // failedCount 0 conta como sucesso, não falha
  });

  it("targetGroupIds com uuid válido manda só pro grupo selecionado, não pros outros do bot", async () => {
    const bot = await createBot();
    const db = await testDb();
    const [selected] = await db.insert(botGroups).values({ botId: bot.id, name: "Selecionado", telegramChatId: -1001111111n, type: "group" }).returning();
    await db.insert(botGroups).values({ botId: bot.id, name: "Não selecionado", telegramChatId: -1002222222n, type: "group" });
    await seedMsg(bot.id, bot.userId, { message: "promo", targetType: "groups", targetGroupIds: [selected.id] });

    await processDueBroadcasts();
    expect(getTelegramCalls("sendMessage").length).toBe(1);
  });
});

describe("processDueBroadcasts — oferta + botão (bug João)", () => {
  it("renderiza o botão da oferta (bcast_buy) junto do conteúdo", async () => {
    const bot = await createBot();
    await createLead(bot.id, 7100n);
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990 }).returning();
    await seedMsg(bot.id, bot.userId, { message: "promo", advancedFilters: { offers: [{ product_id: offer.id, button_text: "Comprar" }] } as Record<string, unknown> });
    await processDueBroadcasts();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
    expect(kb.flat().some((b) => b.callback_data === `bcast_buy_${offer.id}`)).toBe(true);
  });
});

describe("processDueBroadcasts — cor do botão (style)", () => {
  type Btn = { text?: string; callback_data?: string; url?: string; style?: string };

  it("style válido no botão inline é traduzido pro formato do Telegram", async () => {
    const bot = await createBot();
    await createLead(bot.id, 7200n);
    await seedMsg(bot.id, bot.userId, {
      message: "promo",
      advancedFilters: { inline_buttons: [{ text: "Saiba mais", url: "https://x.com", style: "constructive" }] } as Record<string, unknown>,
    });
    await processDueBroadcasts();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.text === "Saiba mais");
    expect(btn?.style).toBe("success");
  });

  it("style inválido no botão inline é descartado (omitido do payload)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 7201n);
    await seedMsg(bot.id, bot.userId, {
      message: "promo",
      advancedFilters: { inline_buttons: [{ text: "Saiba mais", url: "https://x.com", style: "not_a_real_style" }] } as Record<string, unknown>,
    });
    await processDueBroadcasts();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.text === "Saiba mais");
    expect(btn?.style).toBeUndefined();
  });

  it("botão inline sem style não quebra o envio (omitido do payload)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 7202n);
    await seedMsg(bot.id, bot.userId, {
      message: "promo",
      advancedFilters: { inline_buttons: [{ text: "Saiba mais", url: "https://x.com" }] } as Record<string, unknown>,
    });
    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.text === "Saiba mais");
    expect(btn?.style).toBeUndefined();
  });

  it("style válido no botão de oferta é traduzido pro formato do Telegram", async () => {
    const bot = await createBot();
    await createLead(bot.id, 7203n);
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990 }).returning();
    await seedMsg(bot.id, bot.userId, {
      message: "promo",
      advancedFilters: { offers: [{ product_id: offer.id, button_text: "Comprar", style: "destructive" }] } as Record<string, unknown>,
    });
    await processDueBroadcasts();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.callback_data === `bcast_buy_${offer.id}`);
    expect(btn?.style).toBe("danger");
  });

  it("style inválido no botão de oferta é descartado (omitido do payload)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 7204n);
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990 }).returning();
    await seedMsg(bot.id, bot.userId, {
      message: "promo",
      advancedFilters: { offers: [{ product_id: offer.id, button_text: "Comprar", style: "hackerman" }] } as Record<string, unknown>,
    });
    await processDueBroadcasts();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.callback_data === `bcast_buy_${offer.id}`);
    expect(btn?.style).toBeUndefined();
  });
});
