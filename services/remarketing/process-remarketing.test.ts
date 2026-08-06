import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { processDueRemarketing, enrollRemarketingTriggers } from "./application/process-remarketing.use-case.js";
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
