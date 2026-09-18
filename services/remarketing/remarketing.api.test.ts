// Testa a whitelist server-side de `style` (sanitizeButtonStyle/sanitizeButtonArray)
// chamando o handler REAL saveMessages de remarketing.api.ts — não o use-case de
// processamento. process-remarketing.test.ts seeda remarketing_messages direto via
// Drizzle e por isso nunca exercita esse controle de segurança; aqui as mensagens
// passam pelo endpoint PUT /remarketing/:id/messages como o frontend faria.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { remarketingCampaigns, remarketingMessages, remarketingLeadState } from "../shared/schema/index.js";
import { createBot, createLead } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { saveMessages, update } = await import("./remarketing.api.js");

async function campaign(botId: string, over: Partial<typeof remarketingCampaigns.$inferInsert> = {}) {
  const db = await testDb();
  const [c] = await db.insert(remarketingCampaigns).values({
    botId, botIds: [botId], name: "Camp", triggerType: "manual", isActive: true, filterType: "all", ...over,
  }).returning();
  return c;
}

async function state(campaignId: string, botId: string, leadId: string, over: Partial<typeof remarketingLeadState.$inferInsert> = {}) {
  const db = await testDb();
  const [s] = await db.insert(remarketingLeadState).values({
    campaignId, botId, leadId, status: "active", nextSendAt: new Date(), nextMessageIndex: 0, ...over,
  }).returning();
  return s;
}

type Btn = { text?: string; style?: string };

describe("whitelist de style — endpoint real saveMessages (remarketing)", () => {
  it("style inválido em inlineButtons não é persistido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const c = await campaign(bot.id);

    await saveMessages({
      id: c.id,
      messages: [{
        message: "Volte!",
        inlineButtons: [{ text: "Saiba mais", url: "https://x.com", style: "hackerman" }],
        delayValue: 1,
        delayUnit: "days",
        orderIndex: 0,
      }],
    });

    const db = await testDb();
    const [row] = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, c.id));
    const buttons = row.inlineButtons as Btn[];
    expect(buttons[0].style).toBeUndefined();
  });

  it("style válido em inlineButtons é preservado (sanidade — a whitelist não descarta tudo)", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const c = await campaign(bot.id);

    await saveMessages({
      id: c.id,
      messages: [{
        message: "Volte!",
        inlineButtons: [{ text: "Saiba mais", url: "https://x.com", style: "constructive" }],
        delayValue: 1,
        delayUnit: "days",
        orderIndex: 0,
      }],
    });

    const db = await testDb();
    const [row] = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, c.id));
    const buttons = row.inlineButtons as Btn[];
    expect(buttons[0].style).toBe("constructive");
  });

  it("offerStyle inválido não é persistido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const c = await campaign(bot.id);

    await saveMessages({
      id: c.id,
      messages: [{
        message: "Volte!",
        offerStyle: "hackerman",
        delayValue: 1,
        delayUnit: "days",
        orderIndex: 0,
      }],
    });

    const db = await testDb();
    const [row] = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, c.id));
    expect(row.offerStyle).toBeNull();
  });

  it("se o insert falhar, a transação reverte o delete (campanha não fica sem mensagem)", async () => {
    // Regressão: antes, delete+insert rodavam soltos (sem transação) — um insert
    // que falhasse no meio deixava a campanha já sem NENHUMA mensagem (o delete
    // já tinha sido commitado), e o processador pausaria todo lead devido como
    // 'no_messages' sem retomada automática.
    const bot = await createBot();
    authUserId = bot.userId;
    const c = await campaign(bot.id);
    await saveMessages({ id: c.id, messages: [{ message: "Original", delayValue: 1, delayUnit: "days", orderIndex: 0 }] });

    await expect(saveMessages({
      id: c.id,
      // message não pode ser null na coluna (NOT NULL) — força o INSERT a
      // falhar no banco depois que o DELETE já rodou dentro da mesma transação.
      messages: [{ message: null as unknown as string, delayValue: 1, delayUnit: "days", orderIndex: 0 }],
    })).rejects.toThrow();

    const db = await testDb();
    const rows = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, c.id));
    expect(rows.length).toBe(1);
    expect(rows[0].message).toBe("Original");
  });
});

describe("update — reativar campanha (isActive false→true) retoma leads pausados por ela", () => {
  it("volta paused/campaign_inactive para active via PATCH real", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const lead = await createLead(bot.id, 6700n);
    const c = await campaign(bot.id, { isActive: false });
    await state(c.id, bot.id, lead, { status: "paused", pauseReason: "campaign_inactive" });

    await update({ id: c.id, isActive: true });

    const db = await testDb();
    const [row] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.leadId, lead));
    expect(row.status).toBe("active");
    expect(row.pauseReason).toBeNull();
  });

  it("PATCH que já estava ativo não mexe nos pausados por campaign_inactive", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const lead = await createLead(bot.id, 6701n);
    const c = await campaign(bot.id, { isActive: true });
    await state(c.id, bot.id, lead, { status: "paused", pauseReason: "campaign_inactive" });

    await update({ id: c.id, name: "Renomeado" });

    const db = await testDb();
    const [row] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.leadId, lead));
    // Não passou por false→true, então não é a rota de resumo desta subtask —
    // o estado continua como estava.
    expect(row.status).toBe("paused");
  });
});
