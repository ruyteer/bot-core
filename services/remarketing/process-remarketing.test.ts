import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { processDueRemarketing, enrollRemarketingTriggers, resumeLeadsAfterReactivation } from "./application/process-remarketing.use-case.js";
import { testDb } from "../../test/helpers/db.js";
import { remarketingCampaigns, remarketingMessages, remarketingLeadState, payments, leads, funnelOffers } from "../shared/schema/index.js";
import { createBot, createLead, createGateway } from "../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls } from "../../test/helpers/fetch-mock.js";

async function campaign(botId: string, over: Partial<typeof remarketingCampaigns.$inferInsert> = {}) {
  const db = await testDb();
  const [c] = await db.insert(remarketingCampaigns).values({
    botId, botIds: [botId], name: "Camp", triggerType: "manual", isActive: true, filterType: "all", ...over,
  }).returning();
  return c;
}
async function message(campaignId: string, over: Partial<typeof remarketingMessages.$inferInsert> = {}) {
  const db = await testDb();
  const [m] = await db.insert(remarketingMessages).values({
    campaignId, message: "Volte {nome}!", media: {}, inlineButtons: [], delayValue: 1, delayUnit: "days", orderIndex: 0, ...over,
  }).returning();
  return m;
}
async function state(campaignId: string, botId: string, leadId: string, over: Partial<typeof remarketingLeadState.$inferInsert> = {}) {
  const db = await testDb();
  const [s] = await db.insert(remarketingLeadState).values({
    campaignId, botId, leadId, status: "active", nextSendAt: new Date(Date.now() - 1000), nextMessageIndex: 0, ...over,
  }).returning();
  return s;
}

describe("enrollRemarketingTriggers", () => {
  it("trigger 'buyers' inscreve quem pagou", async () => {
    const bot = await createBot();
    const gw = await createGateway({ userId: bot.userId });
    const lead = await createLead(bot.id, 6001n);
    const db = await testDb();
    await db.insert(payments).values({ userId: bot.userId, botId: bot.id, leadId: lead, gatewayId: gw, amount: 1000, status: "paid", paidAt: new Date(Date.now() - 60_000) });
    const c = await campaign(bot.id, { triggerType: "buyers", triggerConfig: { wait_minutes: 0 } as Record<string, unknown> });
    const n = await enrollRemarketingTriggers();
    expect(n).toBe(1);
    const states = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.campaignId, c.id));
    expect(states.length).toBe(1);
    expect(states[0].leadId).toBe(lead);
  });

  it("não inscreve duas vezes o mesmo lead", async () => {
    const bot = await createBot();
    const gw = await createGateway({ userId: bot.userId });
    const lead = await createLead(bot.id, 6002n);
    const db = await testDb();
    await db.insert(payments).values({ userId: bot.userId, botId: bot.id, leadId: lead, gatewayId: gw, amount: 1000, status: "paid", paidAt: new Date(Date.now() - 60_000) });
    await campaign(bot.id, { triggerType: "buyers", triggerConfig: { wait_minutes: 0 } as Record<string, unknown> });
    await enrollRemarketingTriggers();
    const n2 = await enrollRemarketingTriggers();
    expect(n2).toBe(0);
  });
});

describe("processDueRemarketing", () => {
  it("envia a próxima mensagem, interpola {nome} e avança o agendamento", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6003n);
    const c = await campaign(bot.id);
    await message(c.id);
    const st = await state(c.id, bot.id, lead);
    const n = await processDueRemarketing();
    expect(n).toBe(1);
    expect(getSentMessages()).toContain("Volte Lead!");
    const db = await testDb();
    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.totalSent).toBe(1);
    expect(after.nextSendAt.getTime()).toBeGreaterThan(Date.now());
    expect(after.status).toBe("active");
  });

  it("stop_on_purchase: lead que comprou é parado sem enviar", async () => {
    const bot = await createBot();
    const gw = await createGateway({ userId: bot.userId });
    const lead = await createLead(bot.id, 6004n);
    const db = await testDb();
    await db.insert(payments).values({ userId: bot.userId, botId: bot.id, leadId: lead, gatewayId: gw, amount: 1000, status: "paid" });
    const c = await campaign(bot.id, { stopOnPurchase: true });
    await message(c.id);
    const st = await state(c.id, bot.id, lead);
    await processDueRemarketing();
    expect(getSentMessages()).toHaveLength(0);
    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.status).toBe("stopped");
  });

  it("maxCycles=1: ao completar um ciclo, marca completed", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6005n);
    const c = await campaign(bot.id, { maxCycles: 1 });
    await message(c.id); // 1 mensagem → nextIdx volta a 0 = 1 ciclo
    const st = await state(c.id, bot.id, lead);
    await processDueRemarketing();
    const db = await testDb();
    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.status).toBe("completed");
    expect(after.cyclesCompleted).toBe(1);
  });
});

describe("remarketing — oferta anexada renderiza botão de compra", () => {
  it("mensagem com offerId envia botão bcast_buy", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6100n);
    const c = await campaign(bot.id);
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990 }).returning();
    await message(c.id, { offerId: offer.id });
    await state(c.id, bot.id, lead);
    await processDueRemarketing();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
    expect(kb.flat().some((b) => b.callback_data === `bcast_buy_${offer.id}`)).toBe(true);
  });
});

describe("defesa em profundidade — campanha 'suja' com bot de outro dono", () => {
  // Estes testes gravam a campanha/estado DIRETO no banco via Drizzle (não pelo
  // endpoint da API), simulando dados que já existiam antes da checagem de posse
  // em remarketing.api.ts existir. O objetivo é confirmar que o PROCESSADOR
  // também recusa, mesmo que uma linha inválida já esteja gravada.
  it("enrollRemarketingTriggers: não inscreve leads do bot de outro dono mesmo listado em bot_ids", async () => {
    const owner = await createBot();
    const foreignBot = await createBot(); // outro dono
    const gw = await createGateway({ userId: owner.userId });
    const ownLead = await createLead(owner.id, 6300n);
    const foreignLead = await createLead(foreignBot.id, 6301n);
    const foreignGw = await createGateway({ userId: foreignBot.userId });
    const db = await testDb();
    await db.insert(payments).values([
      { userId: owner.userId, botId: owner.id, leadId: ownLead, gatewayId: gw, amount: 1000, status: "paid", paidAt: new Date(Date.now() - 60_000) },
      { userId: foreignBot.userId, botId: foreignBot.id, leadId: foreignLead, gatewayId: foreignGw, amount: 1000, status: "paid", paidAt: new Date(Date.now() - 60_000) },
    ]);
    // Campanha "suja": bot_ids inclui o bot de outro dono (nunca deveria ter sido
    // gravado assim, mas simula dado pré-existente a uma corrupção/bug anterior).
    await campaign(owner.id, { botIds: [owner.id, foreignBot.id], triggerType: "buyers", triggerConfig: { wait_minutes: 0 } as Record<string, unknown> });

    const n = await enrollRemarketingTriggers();
    expect(n).toBe(1);
    const states = await db.select().from(remarketingLeadState);
    expect(states.map((s) => s.leadId)).toEqual([ownLead]);
  });

  it("processDueRemarketing: não envia por um bot que não pertence ao dono da campanha, mesmo com lead_state já gravado", async () => {
    const owner = await createBot();
    const foreignBot = await createBot(); // outro dono
    const lead = await createLead(foreignBot.id, 6302n);
    const c = await campaign(owner.id, { botIds: [owner.id, foreignBot.id] });
    await message(c.id);
    // lead_state gravado direto com bot_id do bot ALHEIO (ex.: enroll manual antes
    // da checagem existir, ou linha corrompida) — processDueRemarketing não pode
    // usar o token desse bot pra enviar.
    const st = await state(c.id, foreignBot.id, lead);

    const n = await processDueRemarketing();
    expect(n).toBe(0);
    expect(getSentMessages()).toHaveLength(0);
    const db = await testDb();
    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.status).toBe("stopped");
    expect(after.pauseReason).toBe("bot_not_owned");
  });

  it("processDueRemarketing: envia normalmente quando o bot do estado pertence ao mesmo dono e está em bot_ids", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6303n);
    const c = await campaign(bot.id, { botIds: [bot.id] });
    await message(c.id);
    await state(c.id, bot.id, lead);

    const n = await processDueRemarketing();
    expect(n).toBe(1);
    expect(getSentMessages().length).toBeGreaterThan(0);
  });
});

describe("remarketing — cor do botão (style)", () => {
  type Btn = { text?: string; callback_data?: string; url?: string; style?: string };

  it("style válido no botão inline é traduzido pro formato do Telegram", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6200n);
    const c = await campaign(bot.id);
    await message(c.id, { inlineButtons: [{ text: "Saiba mais", url: "https://x.com", style: "constructive" }] });
    await state(c.id, bot.id, lead);
    await processDueRemarketing();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.text === "Saiba mais");
    expect(btn?.style).toBe("success");
  });

  it("style inválido no botão inline é descartado (omitido do payload)", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6201n);
    const c = await campaign(bot.id);
    await message(c.id, { inlineButtons: [{ text: "Saiba mais", url: "https://x.com", style: "not_a_real_style" }] });
    await state(c.id, bot.id, lead);
    await processDueRemarketing();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.text === "Saiba mais");
    expect(btn?.style).toBeUndefined();
  });

  it("botão inline sem style não quebra o envio (omitido do payload)", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6202n);
    const c = await campaign(bot.id);
    await message(c.id, { inlineButtons: [{ text: "Saiba mais", url: "https://x.com" }] });
    await state(c.id, bot.id, lead);
    const n = await processDueRemarketing();
    expect(n).toBe(1);
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.text === "Saiba mais");
    expect(btn?.style).toBeUndefined();
  });

  it("offerStyle válido no botão da oferta é traduzido pro formato do Telegram", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6203n);
    const c = await campaign(bot.id);
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990 }).returning();
    await message(c.id, { offerId: offer.id, offerStyle: "destructive" });
    await state(c.id, bot.id, lead);
    await processDueRemarketing();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.callback_data === `bcast_buy_${offer.id}`);
    expect(btn?.style).toBe("danger");
  });

  it("offerStyle inválido no botão da oferta é descartado (omitido do payload)", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6204n);
    const c = await campaign(bot.id);
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990 }).returning();
    await message(c.id, { offerId: offer.id, offerStyle: "hackerman" });
    await state(c.id, bot.id, lead);
    await processDueRemarketing();
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.callback_data === `bcast_buy_${offer.id}`);
    expect(btn?.style).toBeUndefined();
  });

  it("mensagem com offerId sem offerStyle não quebra o envio (omitido do payload)", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6205n);
    const c = await campaign(bot.id);
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990 }).returning();
    await message(c.id, { offerId: offer.id });
    await state(c.id, bot.id, lead);
    const n = await processDueRemarketing();
    expect(n).toBe(1);
    const call = getTelegramCalls("sendMessage")[0];
    const kb = (call.body.reply_markup as { inline_keyboard: Btn[][] }).inline_keyboard;
    const btn = kb.flat().find((b) => b.callback_data === `bcast_buy_${offer.id}`);
    expect(btn?.style).toBeUndefined();
  });
});

describe("resumeLeadsAfterReactivation — reativar campanha retoma leads pausados por ela", () => {
  it("volta paused/campaign_inactive para active, com nextSendAt no futuro (não dispara tudo de uma vez)", async () => {
    const bot = await createBot();
    const lead1 = await createLead(bot.id, 6400n);
    const lead2 = await createLead(bot.id, 6401n);
    const c = await campaign(bot.id, { isActive: false });
    const before = new Date(Date.now() - 1000);
    const st1 = await state(c.id, bot.id, lead1, { status: "paused", pauseReason: "campaign_inactive", nextSendAt: before });
    const st2 = await state(c.id, bot.id, lead2, { status: "paused", pauseReason: "campaign_inactive", nextSendAt: before });

    const n = await resumeLeadsAfterReactivation(c.id);
    expect(n).toBe(2);

    const db = await testDb();
    const rows = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.campaignId, c.id));
    const after1 = rows.find((r) => r.id === st1.id)!;
    const after2 = rows.find((r) => r.id === st2.id)!;
    expect(after1.status).toBe("active");
    expect(after1.pauseReason).toBeNull();
    expect(after2.status).toBe("active");
    // Escalonado: os dois não ficam com o mesmo nextSendAt, e nenhum volta a ficar
    // devido imediatamente (nextSendAt no futuro) — evita rajada na reativação.
    expect(after1.nextSendAt.getTime()).toBeGreaterThan(Date.now());
    expect(after2.nextSendAt.getTime()).toBeGreaterThan(after1.nextSendAt.getTime());
  });

  it("não mexe em paused por outro motivo (ex.: no_messages)", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6402n);
    const c = await campaign(bot.id, { isActive: false });
    const st = await state(c.id, bot.id, lead, { status: "paused", pauseReason: "no_messages" });

    const n = await resumeLeadsAfterReactivation(c.id);
    expect(n).toBe(0);

    const db = await testDb();
    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.status).toBe("paused");
    expect(after.pauseReason).toBe("no_messages");
  });

  it("não mexe em estados stopped/blocked mesmo que a campanha reative", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6403n);
    const c = await campaign(bot.id, { isActive: false });
    const st = await state(c.id, bot.id, lead, { status: "stopped", pauseReason: "purchased" });

    const n = await resumeLeadsAfterReactivation(c.id);
    expect(n).toBe(0);

    const db = await testDb();
    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.status).toBe("stopped");
  });

  it("depois de retomado, o lead é processado normalmente quando o nextSendAt chega", async () => {
    const bot = await createBot();
    const lead = await createLead(bot.id, 6404n);
    const c = await campaign(bot.id, { isActive: true });
    await message(c.id);
    await state(c.id, bot.id, lead, { status: "paused", pauseReason: "campaign_inactive", nextSendAt: new Date(Date.now() - 1000) });

    await resumeLeadsAfterReactivation(c.id);
    // Ainda não está devido (nextSendAt escalonado no futuro) — processDueRemarketing não pega.
    const n1 = await processDueRemarketing();
    expect(n1).toBe(0);

    // Adianta o relógio manualmente pra simular a passagem do tempo até o nextSendAt.
    const db = await testDb();
    await db.update(remarketingLeadState).set({ nextSendAt: new Date(Date.now() - 1000) }).where(eq(remarketingLeadState.campaignId, c.id));
    const n2 = await processDueRemarketing();
    expect(n2).toBe(1);
  });
});

describe("gatilho 'buyers' + stopOnPurchase=true já gravado: processador NÃO corrige por baixo", () => {
  it("continua parando sem enviar (proposital — ver create/update pra correção na escrita)", async () => {
    // Campanha "suja": triggerType='buyers' + stopOnPurchase=true, combinação que
    // create/update em remarketing.api.ts passam a recusar a partir desta versão
    // — mas uma campanha JÁ gravada assim antes disso (ativa e silenciosa em
    // produção, possivelmente há semanas/meses) não deve ser "corrigida" por
    // baixo dos panos pelo processador: o gatilho 'buyers' inscreve compradores
    // HISTÓRICOS (sem piso de data — ver enrollRemarketingTriggers), então
    // destravar o envio aqui mandaria mensagem de uma vez pra todo comprador
    // antigo já inscrito, sem o dono ter mexido conscientemente na campanha.
    const bot = await createBot();
    const gw = await createGateway({ userId: bot.userId });
    const lead = await createLead(bot.id, 6500n);
    const db = await testDb();
    await db.insert(payments).values({ userId: bot.userId, botId: bot.id, leadId: lead, gatewayId: gw, amount: 1000, status: "paid" });
    const c = await campaign(bot.id, { triggerType: "buyers", stopOnPurchase: true });
    await message(c.id);
    const st = await state(c.id, bot.id, lead);

    const n = await processDueRemarketing();
    expect(n).toBe(0);
    expect(getSentMessages()).toHaveLength(0);
    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.status).toBe("stopped");
    expect(after.pauseReason).toBe("purchased");
  });
});
