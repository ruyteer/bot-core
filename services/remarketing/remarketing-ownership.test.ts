// Testes de regressão do IDOR crítico: qualquer conta conseguia gravar botIds/
// targetGroupIds/offerId de OUTRO usuário numa campanha de remarketing (create/
// PATCH/saveMessages), e o enroll manual não filtrava leads pelo dono real da
// campanha. Como o envio usa o TOKEN DO BOT DA VÍTIMA (não o do atacante), isso
// permitia mandar mensagem — com botão de compra — pros leads de outra conta.
// Chama os handlers REAIS de remarketing.api.ts, não o repositório direto.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import { testDb } from "../../test/helpers/db.js";
import { remarketingCampaigns, remarketingMessages, botGroups, funnelOffers } from "../shared/schema/index.js";
import { createBot, createLead } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { create, update, saveMessages, enroll } = await import("./remarketing.api.js");

async function createGroup(botId: string, chatId: bigint) {
  const db = await testDb();
  const [g] = await db.insert(botGroups).values({ botId, telegramChatId: chatId, name: "Grupo" }).returning();
  return g;
}

describe("posse de bot/grupo/oferta — endpoints reais de remarketing", () => {
  it("create: rejeita botId de outro usuário", async () => {
    const owner = await createBot();
    const attacker = await createBot();
    authUserId = attacker.userId;

    await expect(create({ botId: owner.id, name: "Camp" })).rejects.toThrow();
  });

  it("create: rejeita botIds com um id alheio misturado, sem criar a campanha", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const attackerBot = await createBot();

    await expect(create({ botId: owner.id, botIds: [owner.id, attackerBot.id], name: "Camp" })).rejects.toThrow();

    const db = await testDb();
    const rows = await db.select().from(remarketingCampaigns).where(eq(remarketingCampaigns.botId, owner.id));
    expect(rows.length).toBe(0);
  });

  it("create: rejeita botIds vazio (campanha ficaria órfã)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;

    await expect(create({ botId: owner.id, botIds: [], name: "Camp" })).rejects.toThrow();
  });

  it("create: rejeita targetGroupIds de grupo de bot alheio", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const attackerBot = await createBot();
    const foreignGroup = await createGroup(attackerBot.id, -1001n);

    await expect(
      create({ botId: owner.id, name: "Camp", targetGroupIds: [foreignGroup.id] }),
    ).rejects.toThrow();
  });

  it("create: aceita bots e grupo próprios (caso feliz)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const group = await createGroup(owner.id, -1002n);

    const c = await create({ botId: owner.id, name: "Camp", targetGroupIds: [group.id] });
    expect(c.botId).toBe(owner.id);
    expect(c.targetGroupIds).toEqual([group.id]);
  });

  it("update: rejeita botIds com bot alheio, sem gravar", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const c = await create({ botId: owner.id, name: "Camp" });
    const attackerBot = await createBot();

    await expect(update({ id: c.id, botIds: [owner.id, attackerBot.id] })).rejects.toThrow();

    const db = await testDb();
    const [row] = await db.select().from(remarketingCampaigns).where(eq(remarketingCampaigns.id, c.id));
    expect(row.botIds).toEqual([owner.id]);
  });

  it("update: rejeita botIds vazio", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const c = await create({ botId: owner.id, name: "Camp" });

    await expect(update({ id: c.id, botIds: [] })).rejects.toThrow();
  });

  it("update: rejeita targetGroupIds de grupo de bot alheio", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const c = await create({ botId: owner.id, name: "Camp" });
    const attackerBot = await createBot();
    const foreignGroup = await createGroup(attackerBot.id, -1003n);

    await expect(update({ id: c.id, targetGroupIds: [foreignGroup.id] })).rejects.toThrow();
  });

  it("update: rejeita campanha de outro usuário (404, não vaza existência)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const c = await create({ botId: owner.id, name: "Camp" });

    const attacker = await createBot();
    authUserId = attacker.userId;
    let caught: unknown;
    try { await update({ id: c.id, name: "Hijacked" }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).code).toBe("not_found");
  });

  it("saveMessages: rejeita offerId de oferta de bot fora da campanha", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const c = await create({ botId: owner.id, name: "Camp" });
    const otherBot = await createBot({ userId: owner.userId }); // mesmo dono, mas fora da campanha
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: otherBot.id, name: "Oferta", price: 1000 }).returning();

    await expect(
      saveMessages({ id: c.id, messages: [{ message: "Oi", offerId: offer.id, delayValue: 1, delayUnit: "days", orderIndex: 0 }] }),
    ).rejects.toThrow();

    const rows = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, c.id));
    expect(rows.length).toBe(0); // nada foi gravado (delete+insert não rodou)
  });

  it("saveMessages: aceita offerId de oferta de um dos bots da campanha", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const c = await create({ botId: owner.id, name: "Camp" });
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: owner.id, name: "Oferta", price: 1000 }).returning();

    await saveMessages({ id: c.id, messages: [{ message: "Oi", offerId: offer.id, delayValue: 1, delayUnit: "days", orderIndex: 0 }] });

    const rows = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, c.id));
    expect(rows[0].offerId).toBe(offer.id);
  });

  it("enroll: campanha 'suja' gravada direto no banco com bot alheio em botIds não inscreve o lead desse bot", async () => {
    const owner = await createBot();
    const attackerVictim = await createBot(); // bot de outro dono, "vazado" pra dentro da campanha
    const db = await testDb();
    const [c] = await db.insert(remarketingCampaigns).values({
      botId: owner.id, botIds: [owner.id, attackerVictim.id], name: "Suja", triggerType: "manual", isActive: true, filterType: "all",
    }).returning();

    await createLead(attackerVictim.id, 9001n); // lead do bot alheio — nunca deve ser considerado
    await createLead(owner.id, 9002n);

    authUserId = owner.userId;
    const result = await enroll({ id: c.id });

    // só o lead do bot do próprio dono é considerado — o total elegível já exclui o bot alheio.
    expect(result.total).toBe(1);
    expect(result.enrolled).toBe(1);
  });
});
