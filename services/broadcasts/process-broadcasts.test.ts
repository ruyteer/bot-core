import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { processDueBroadcasts } from "./application/process-broadcasts.use-case.js";
import { testDb } from "../../test/helpers/db.js";
import { scheduledMessages, broadcastRuns, broadcastDeliveries, bots, payments, leads, funnelOffers, botGroups, funnelBots } from "../shared/schema/index.js";
import { createBot, createLead, createGateway, createFlowFunnel, createSimplifiedFunnel, getProgress } from "../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls, forceTelegramError } from "../../test/helpers/fetch-mock.js";
import { ExecuteFlowStepUseCase } from "../runner/application/execute-flow-step.use-case.js";

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

  it("filterType 'product' com filterProductId de oferta de OUTRO bot não envia pra ninguém (nunca vaza pagamento cross-tenant)", async () => {
    // filterProductId nunca é validado contra o dono na escrita (create/send/PATCH),
    // mas getAudienceLeads sempre casa payments.botId=<bot do broadcast> E
    // payments.offerId=filterProductId — um offerId de outro bot/dono nunca bate
    // nenhum pagamento DESTE bot, então o filtro resulta em audiência vazia, nunca
    // em leads de outro tenant. Ver services/broadcasts/application/process-broadcasts.use-case.ts:71-76.
    const owner = await createBot();
    const foreignBot = await createBot(); // outro dono
    const gw = await createGateway({ userId: owner.userId });
    const foreignGw = await createGateway({ userId: foreignBot.userId });
    const ownLead = await createLead(owner.id, 5100n);
    const foreignLead = await createLead(foreignBot.id, 5101n);
    const db = await testDb();
    const [foreignOffer] = await db.insert(funnelOffers).values({ botId: foreignBot.id, name: "Oferta alheia", price: 1000 }).returning();
    // Pagamento real do bot alheio pra essa oferta (é o que teríamos vazado se o
    // filtro não fosse escopado por botId).
    await db.insert(payments).values({ userId: foreignBot.userId, botId: foreignBot.id, leadId: foreignLead, gatewayId: foreignGw, amount: 1000, offerId: foreignOffer.id, status: "paid" });
    // O dono do broadcast também tem um comprador — mas de OUTRA oferta (não a filtrada).
    const [ownOffer] = await db.insert(funnelOffers).values({ botId: owner.id, name: "Oferta própria", price: 1000 }).returning();
    await db.insert(payments).values({ userId: owner.userId, botId: owner.id, leadId: ownLead, gatewayId: gw, amount: 1000, offerId: ownOffer.id, status: "paid" });

    await seedMsg(owner.id, owner.userId, {
      filterType: "product",
      advancedFilters: { filter_product_id: foreignOffer.id },
      message: "promo",
    });

    await processDueBroadcasts();
    expect(getTelegramCalls("sendMessage").length).toBe(0);
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

// Regressão do item de backlog "envio duplicado pro público inteiro": um
// disparo preso em "sending" por >10min (deploy, timeout) voltava pra
// "pending" e reprocessava a audiência INTEIRA de novo, mesmo quem já tinha
// recebido — sem heartbeat, sem CAS explícito, sem registro por lead. A
// correção adiciona broadcast_deliveries (registro por lead/ocorrência,
// consultado antes de enviar) e mantém o claim atômico (CAS na UPDATE) que já
// existia.
describe("processDueBroadcasts — resgate não reenvia quem já recebeu (fix duplicidade)", () => {
  it("disparo travado em 'sending' há mais de 10min é resgatado, mas pula quem já está em broadcast_deliveries", async () => {
    const bot = await createBot();
    const lead1 = await createLead(bot.id, 9101n); // já recebeu antes do travamento
    const lead2 = await createLead(bot.id, 9102n); // ainda não recebeu

    const db = await testDb();
    const scheduledAt = new Date(Date.now() - 20 * 60_000);
    const staleUpdatedAt = new Date(Date.now() - 11 * 60_000); // >10min sem heartbeat
    const [msg] = await db.insert(scheduledMessages).values({
      userId: bot.userId, botId: bot.id, botIds: [bot.id], message: "promo",
      broadcastType: "instant", filterType: "all", targetType: "leads", targetGroupIds: [],
      scheduledAt, status: "sending", updatedAt: staleUpdatedAt,
    }).returning();
    // Simula que lead1 já recebeu na tentativa anterior (antes do processo travar).
    await db.insert(broadcastDeliveries).values({ scheduledMessageId: msg.id, occurrenceAt: scheduledAt, leadId: lead1 });

    const n = await processDueBroadcasts();
    expect(n).toBe(1); // resgatou e reprocessou o disparo

    const sent = getTelegramCalls("sendMessage");
    expect(sent.length).toBe(1); // só lead2 — lead1 não recebeu de novo

    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("sent");

    const runs = await db.select().from(broadcastRuns).where(eq(broadcastRuns.scheduledMessageId, msg.id));
    expect(runs[0].totalTargets).toBe(1); // lead1 pulado não conta como alvo desta tentativa
    expect(runs[0].sentCount).toBe(1);
  });
});

describe("processDueBroadcasts — claim concorrente (fix duplicidade)", () => {
  it("duas chamadas concorrentes de processDueBroadcasts não enviam o mesmo disparo duas vezes", async () => {
    const bot = await createBot();
    await createLead(bot.id, 9201n);
    await seedMsg(bot.id, bot.userId, { message: "promo" });

    const [n1, n2] = await Promise.all([processDueBroadcasts(), processDueBroadcasts()]);
    expect(n1 + n2).toBe(1); // só uma das duas chamadas efetivamente processou o disparo
    expect(getTelegramCalls("sendMessage").length).toBe(1); // lead recebe uma única vez
  });
});

describe("processDueBroadcasts — bot inativo (não envia por bot desativado)", () => {
  it("bot com isActive=false é pulado, sem quebrar o processamento do disparo", async () => {
    const bot = await createBot();
    await createLead(bot.id, 9301n);
    const db = await testDb();
    await db.update(bots).set({ isActive: false }).where(eq(bots.id, bot.id));
    await seedMsg(bot.id, bot.userId, { message: "promo" });

    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    expect(getTelegramCalls("sendMessage").length).toBe(0); // bot inativo, ninguém recebe
  });
});

describe("processDueBroadcasts — disparo inicia funil (funnelId)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lead entra no funil de fluxo depois de receber o disparo", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 9401n);
    const { funnelId } = await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo ao funil!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });
    await seedMsg(bot.id, bot.userId, { message: "promo", funnelId });

    const n = await processDueBroadcasts();
    expect(n).toBe(1);

    // A mensagem do disparo E a primeira mensagem do funil devem ter sido enviadas.
    expect(getSentMessages()).toContain("promo");
    expect(getSentMessages()).toContain("Bem-vindo ao funil!");

    const prog = await getProgress(leadId);
    expect(prog).toBeDefined();
    expect(prog.funnelId).toBe(funnelId);
    // Nó "msg" não tem saída — o funil roda até o fim e completa (mesmo
    // comportamento do /start): currentNodeId some, status vira "completed".
    expect(prog.status).toBe("completed");
  });

  it("funil SIMPLIFICADO referenciado no disparo é ignorado (não tem nós pra entrar)", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 9402n);
    const funnelId = await createSimplifiedFunnel({
      userId: bot.userId,
      botId: bot.id,
      config: {},
    });
    await seedMsg(bot.id, bot.userId, { message: "promo", funnelId });

    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    expect(getSentMessages()).toContain("promo"); // disparo sai normalmente

    const prog = await getProgress(leadId);
    expect(prog).toBeUndefined(); // lead não entrou em funil nenhum
  });

  it("funil INATIVO referenciado no disparo é ignorado", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 9403n);
    const { funnelId } = await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      isActive: false,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo ao funil!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });
    await seedMsg(bot.id, bot.userId, { message: "promo", funnelId });

    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    expect(getSentMessages()).toContain("promo");
    expect(getSentMessages()).not.toContain("Bem-vindo ao funil!");

    const prog = await getProgress(leadId);
    expect(prog).toBeUndefined();
  });

  it("funil de fluxo SEM nó trigger referenciado no disparo é ignorado", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 9404n);
    const { funnelId } = await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        // Sem nó "trigger" de propósito.
        { key: "msg", type: "message", content: { message: "Nunca deveria ser alcançado" } },
      ],
      connections: [],
    });
    await seedMsg(bot.id, bot.userId, { message: "promo", funnelId });

    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    expect(getSentMessages()).toContain("promo");
    expect(getSentMessages()).not.toContain("Nunca deveria ser alcançado");

    const prog = await getProgress(leadId);
    expect(prog).toBeUndefined();
  });

  it("falha ao iniciar o funil não impede o envio do disparo (erro isolado, não conta como falha de entrega)", async () => {
    vi.spyOn(ExecuteFlowStepUseCase.prototype, "startFunnelForLead").mockRejectedValueOnce(new Error("boom"));

    const bot = await createBot();
    await createLead(bot.id, 9405n);
    const { funnelId } = await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo ao funil!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });
    const msg = await seedMsg(bot.id, bot.userId, { message: "promo", funnelId });

    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    expect(getSentMessages()).toContain("promo"); // envio aconteceu apesar do erro no funil

    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("sent"); // não vira 'failed'/'partial' por causa do erro no funil

    const runs = await db.select().from(broadcastRuns).where(eq(broadcastRuns.scheduledMessageId, msg.id));
    expect(runs[0].sentCount).toBe(1);
    expect(runs[0].failedCount).toBe(0);
  });

  it("disparo para vários bots: só o lead do bot que tem o funil entra nele", async () => {
    const botA = await createBot();
    const botB = await createBot({ userId: botA.userId });
    const leadA = await createLead(botA.id, 9406n);
    const leadB = await createLead(botB.id, 9407n);
    const { funnelId } = await createFlowFunnel({
      userId: botA.userId,
      botId: botA.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo ao funil!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });
    await seedMsg(botA.id, botA.userId, { message: "promo", funnelId, botIds: [botA.id, botB.id] });

    await processDueBroadcasts();

    // Os dois recebem o disparo; só o do bot A entra no funil.
    expect(getSentMessages().filter((m) => m === "promo")).toHaveLength(2);
    expect((await getProgress(leadA))?.funnelId).toBe(funnelId);
    expect(await getProgress(leadB)).toBeUndefined();
  });

  it("bot vinculado ao funil por funnel_bots (não é o bot principal) também entra", async () => {
    const botA = await createBot();
    const botB = await createBot({ userId: botA.userId });
    const leadB = await createLead(botB.id, 9408n);
    const { funnelId } = await createFlowFunnel({
      userId: botA.userId,
      botId: botA.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo ao funil!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });
    const db = await testDb();
    await db.insert(funnelBots).values({ funnelId, botId: botB.id });
    await seedMsg(botB.id, botB.userId, { message: "promo", funnelId });

    await processDueBroadcasts();

    expect((await getProgress(leadB))?.funnelId).toBe(funnelId);
  });

  it("grupos/canais nunca entram em funil, mesmo com funnelId no disparo", async () => {
    const bot = await createBot();
    const { funnelId } = await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo ao funil!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });
    const db = await testDb();
    const [group] = await db.insert(botGroups).values({
      botId: bot.id, telegramChatId: -1001234567890n, name: "Grupo Teste", type: "supergroup",
    }).returning();

    await seedMsg(bot.id, bot.userId, {
      message: "promo", funnelId, targetType: "groups", targetGroupIds: [group.id],
    });

    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    expect(getSentMessages()).toContain("promo");
    // Nenhum lead existe nesse teste — mas o essencial é não quebrar e não
    // tentar startFunnelForLead para o grupo (não há leadId de grupo).
  });
});
