import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { FunnelDrizzleRepository } from "./infrastructure/funnel.drizzle.repository.js";
import { testDb } from "../../test/helpers/db.js";
import { funnels, funnelNodes, nodeConnections, funnelBots } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";

const repo = new FunnelDrizzleRepository();

async function newFunnel(kind = "flow") {
  const bot = await createBot();
  const f = await repo.create({ userId: bot.userId, botId: bot.id, name: "F", kind });
  return { bot, funnelId: f.id };
}

describe("FunnelDrizzleRepository", () => {
  it("create vincula o funil ao bot em funnel_bots", async () => {
    const { bot, funnelId } = await newFunnel();
    const db = await testDb();
    const links = await db.select().from(funnelBots).where(eq(funnelBots.funnelId, funnelId));
    expect(links.length).toBe(1);
    expect(links[0].botId).toBe(bot.id);
  });

  it("saveFlow coage tipo inválido para 'message' e substitui tudo", async () => {
    const { bot, funnelId } = await newFunnel();
    const n1 = crypto.randomUUID(); const n2 = crypto.randomUUID();
    await repo.saveFlow(funnelId, bot.userId, {
      nodes: [
        { id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 },
        { id: n2, type: "tipo_invalido", content: { message: "x" }, positionX: 0, positionY: 0 },
      ],
      connections: [{ id: crypto.randomUUID(), sourceNodeId: n1, sourceHandle: null, targetNodeId: n2 }],
    });
    const db = await testDb();
    const nodes = await db.select().from(funnelNodes).where(eq(funnelNodes.funnelId, funnelId));
    const invalid = nodes.find((n) => n.id === n2);
    expect(invalid!.type).toBe("message"); // coagido
    const conns = await db.select().from(nodeConnections).where(eq(nodeConnections.funnelId, funnelId));
    expect(conns.length).toBe(1);
  });

  it("saveFlow rejeita funil de outro usuário", async () => {
    const { funnelId } = await newFunnel();
    await expect(repo.saveFlow(funnelId, crypto.randomUUID(), { nodes: [], connections: [] }))
      .rejects.toThrow();
  });

  it("activate desativa os outros funis do mesmo bot (1 ativo por bot)", async () => {
    const bot = await createBot();
    const a = await repo.create({ userId: bot.userId, botId: bot.id, name: "A", kind: "flow" });
    const b = await repo.create({ userId: bot.userId, botId: bot.id, name: "B", kind: "flow" });
    await repo.activate(a.id, bot.userId);
    await repo.activate(b.id, bot.userId);
    const db = await testDb();
    const rows = await db.select().from(funnels).where(eq(funnels.botId, bot.id));
    expect(rows.filter((r) => r.isActive).length).toBe(1);
    expect(rows.find((r) => r.id === b.id)!.isActive).toBe(true);
    expect(rows.find((r) => r.id === a.id)!.isActive).toBe(false);
  });

  it("duplicate remapeia ids dos nós e mantém só conexões válidas", async () => {
    const { bot, funnelId } = await newFunnel();
    const n1 = crypto.randomUUID(); const n2 = crypto.randomUUID();
    await repo.saveFlow(funnelId, bot.userId, {
      nodes: [
        { id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 },
        { id: n2, type: "message", content: { message: "oi" }, positionX: 0, positionY: 0 },
      ],
      connections: [{ id: crypto.randomUUID(), sourceNodeId: n1, sourceHandle: null, targetNodeId: n2 }],
    });
    const dup = await repo.duplicate(funnelId, bot.userId, bot.id);
    const db = await testDb();
    const dupNodes = await db.select().from(funnelNodes).where(eq(funnelNodes.funnelId, dup.id));
    expect(dupNodes.length).toBe(2);
    expect(dupNodes.find((n) => n.id === n1)).toBeUndefined(); // ids remapeados
    const dupConns = await db.select().from(nodeConnections).where(eq(nodeConnections.funnelId, dup.id));
    expect(dupConns.length).toBe(1);
    expect(dup.isActive).toBe(false);
  });
});
