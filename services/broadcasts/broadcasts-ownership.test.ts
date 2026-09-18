// Testes de regressão: targetGroupIds e funnelId vindos do cliente em create/
// send/PATCH nunca eram checados contra o dono autenticado (botId/botIds já
// eram — ver broadcasts.api.ts). Chama os handlers REAIS, não o repositório.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { scheduledMessages, botGroups } from "../shared/schema/index.js";
import { createBot, createFlowFunnel } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { create, update, send } = await import("./broadcasts.api.js");

async function createGroup(botId: string, chatId: bigint) {
  const db = await testDb();
  const [g] = await db.insert(botGroups).values({ botId, telegramChatId: chatId, name: "Grupo" }).returning();
  return g;
}

describe("posse de grupo/funil — endpoints reais de broadcasts", () => {
  it("create: rejeita targetGroupIds de grupo de bot alheio, sem criar o broadcast", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const attackerBot = await createBot();
    const foreignGroup = await createGroup(attackerBot.id, -2001n);

    await expect(create({
      botId: owner.id, message: "promo", scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      targetGroupIds: [foreignGroup.id],
    })).rejects.toThrow();

    const db = await testDb();
    const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.botId, owner.id));
    expect(rows.length).toBe(0);
  });

  it("create: rejeita funnelId de outro usuário", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const attacker = await createBot();
    const { funnelId: attackerFunnelId } = await createFlowFunnel({
      userId: attacker.userId, botId: attacker.id, nodes: [{ key: "t", type: "trigger" }], connections: [],
    });

    await expect(create({
      botId: owner.id, message: "promo", scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      funnelId: attackerFunnelId,
    })).rejects.toThrow();
  });

  it("create: aceita grupo e funil próprios (caso feliz)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const group = await createGroup(owner.id, -2002n);
    const { funnelId } = await createFlowFunnel({
      userId: owner.userId, botId: owner.id, nodes: [{ key: "t", type: "trigger" }], connections: [],
    });

    const created = await create({
      botId: owner.id, message: "promo", scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      targetGroupIds: [group.id], funnelId,
    });
    expect(created.targetGroupIds).toEqual([group.id]);
    expect(created.funnelId).toBe(funnelId);
  });

  it("send: rejeita targetGroupIds de grupo de bot alheio", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const attackerBot = await createBot();
    const foreignGroup = await createGroup(attackerBot.id, -2003n);

    await expect(send({
      botIds: [owner.id], broadcastType: "instant", filterType: "all", targetType: "groups",
      targetGroupIds: [foreignGroup.id],
    })).rejects.toThrow();
  });

  it("send: rejeita funnelId de outro usuário", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const attacker = await createBot();
    const { funnelId: attackerFunnelId } = await createFlowFunnel({
      userId: attacker.userId, botId: attacker.id, nodes: [{ key: "t", type: "trigger" }], connections: [],
    });

    await expect(send({
      botIds: [owner.id], broadcastType: "instant", filterType: "all", targetType: "leads",
      targetGroupIds: [], funnelId: attackerFunnelId,
    })).rejects.toThrow();
  });

  it("update: rejeita targetGroupIds de grupo de bot alheio, sem alterar o broadcast", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const created = await create({ botId: owner.id, message: "promo", scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    const attackerBot = await createBot();
    const foreignGroup = await createGroup(attackerBot.id, -2004n);

    await expect(update({ id: created.id, targetGroupIds: [foreignGroup.id] })).rejects.toThrow();

    const db = await testDb();
    const [row] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, created.id));
    expect(row.targetGroupIds).toEqual([]);
  });

  it("update: aceita targetGroupIds de grupo próprio (caso feliz)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const created = await create({ botId: owner.id, message: "promo", scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    const group = await createGroup(owner.id, -2005n);

    const updated = await update({ id: created.id, targetGroupIds: [group.id] });
    expect(updated.targetGroupIds).toEqual([group.id]);
  });
});
