import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import { FunnelDrizzleRepository } from "./infrastructure/funnel.drizzle.repository.js";
import { testDb } from "../../test/helpers/db.js";
import {
  funnels, funnelNodes, nodeConnections, funnelBots,
  leadProgress, scheduledDelays, payments, paymentGateways,
} from "../shared/schema/index.js";
import { createBot, createLead, createGateway } from "../../test/helpers/seed.js";

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

  it("saveFlow aceita id de conexão não-uuid (default 'xy-edge__' do React Flow) regenerando server-side", async () => {
    const { bot, funnelId } = await newFunnel();
    const n1 = crypto.randomUUID(); const n2 = crypto.randomUUID();
    await repo.saveFlow(funnelId, bot.userId, {
      nodes: [
        { id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 },
        { id: n2, type: "message", content: { message: "x" }, positionX: 0, positionY: 0 },
      ],
      connections: [{ id: `xy-edge__${n1}-${n2}`, sourceNodeId: n1, sourceHandle: null, targetNodeId: n2 }],
    });
    const db = await testDb();
    const conns = await db.select().from(nodeConnections).where(eq(nodeConnections.funnelId, funnelId));
    expect(conns.length).toBe(1);
    expect(conns[0].sourceNodeId).toBe(n1);
    expect(conns[0].targetNodeId).toBe(n2);
  });

  it("saveFlow é transacional: falha no insert não apaga o fluxo antigo", async () => {
    const { bot, funnelId } = await newFunnel();
    const n1 = crypto.randomUUID(); const n2 = crypto.randomUUID();
    await repo.saveFlow(funnelId, bot.userId, {
      nodes: [
        { id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 },
        { id: n2, type: "message", content: { message: "x" }, positionX: 0, positionY: 0 },
      ],
      connections: [{ id: crypto.randomUUID(), sourceNodeId: n1, sourceHandle: null, targetNodeId: n2 }],
    });

    // Conexão apontando p/ nó inexistente → violação de FK no meio do replace.
    await expect(repo.saveFlow(funnelId, bot.userId, {
      nodes: [{ id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 }],
      connections: [{ id: crypto.randomUUID(), sourceNodeId: n1, sourceHandle: null, targetNodeId: crypto.randomUUID() }],
    })).rejects.toThrow();

    const db = await testDb();
    const nodes = await db.select().from(funnelNodes).where(eq(funnelNodes.funnelId, funnelId));
    const conns = await db.select().from(nodeConnections).where(eq(nodeConnections.funnelId, funnelId));
    expect(nodes.length).toBe(2);  // fluxo antigo intacto
    expect(conns.length).toBe(1);  // conexões NÃO foram apagadas
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

// Regressão do bug de produção: `saveFlow` fazia full delete+insert de TODOS
// os nós a cada save (autosave inclusive), mesmo preservando ids nos inserts.
// O DELETE por si só já dispara as FKs — lead_progress.current_node_id e
// funnel_offers.node_id iam pra NULL (ON DELETE SET NULL), scheduled_delays e
// payments.node_id perdiam a referência também. Ou seja: qualquer autosave de
// um funil ATIVO tirava leads da posição, apagava delay agendado e podia
// impedir um PIX pago de retomar o funil. Estes testes provam que o save
// DIFERENCIAL (update do que existe, insert do novo, delete só do removido)
// preserva essas referências para os nós que continuam existindo.
describe("FunnelDrizzleRepository.saveFlow — save diferencial preserva referências de FK", () => {
  async function setupActiveFunnelWithLead() {
    const bot = await createBot();
    const funnel = await repo.create({ userId: bot.userId, botId: bot.id, name: "F", kind: "flow" });
    const n1 = crypto.randomUUID();
    const n2 = crypto.randomUUID();
    await repo.saveFlow(funnel.id, bot.userId, {
      nodes: [
        { id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 },
        { id: n2, type: "message", content: { message: "olá" }, positionX: 100, positionY: 0 },
      ],
      connections: [{ id: crypto.randomUUID(), sourceNodeId: n1, sourceHandle: null, targetNodeId: n2 }],
    });

    const lead = await createLead(bot.id, BigInt(123456));
    const db = await testDb();
    const [progress] = await db.insert(leadProgress).values({
      leadId: lead, funnelId: funnel.id, currentNodeId: n2, status: "active",
    }).returning();

    await db.insert(scheduledDelays).values({
      botId: bot.id, leadId: lead, funnelId: funnel.id,
      progressId: progress.id, nextNodeId: n2,
      executeAt: new Date(Date.now() + 60_000),
    });

    const gatewayId = await createGateway({ userId: bot.userId });
    const [payment] = await db.insert(payments).values({
      userId: bot.userId, botId: bot.id, leadId: lead, gatewayId,
      amount: 1000, status: "pending", nodeId: n2,
    }).returning();

    return { bot, funnel, n1, n2, lead, progress, payment };
  }

  it("mantém lead_progress.current_node_id, scheduled_delays e payments.node_id quando o nó referenciado continua no save (só move posição)", async () => {
    const { bot, funnel, n1, n2, payment, progress } = await setupActiveFunnelWithLead();
    const n3 = crypto.randomUUID();

    // Autosave típico: move n2 de posição e adiciona um nó novo n3.
    await repo.saveFlow(funnel.id, bot.userId, {
      nodes: [
        { id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 },
        { id: n2, type: "message", content: { message: "olá" }, positionX: 250, positionY: 40 },
        { id: n3, type: "message", content: { message: "novo" }, positionX: 400, positionY: 0 },
      ],
      connections: [{ id: crypto.randomUUID(), sourceNodeId: n1, sourceHandle: null, targetNodeId: n2 }],
    });

    const db = await testDb();
    const nodes = await db.select().from(funnelNodes).where(eq(funnelNodes.funnelId, funnel.id));
    expect(nodes.length).toBe(3); // n1, n2 (atualizado) e n3 (novo)
    const movedNode = nodes.find((n) => n.id === n2)!;
    expect(movedNode.positionX).toBe(250); // update aplicado, não recriação

    const [progressRow] = await db.select().from(leadProgress).where(eq(leadProgress.id, progress.id));
    expect(progressRow.currentNodeId).toBe(n2); // NÃO virou null

    const delays = await db.select().from(scheduledDelays).where(eq(scheduledDelays.progressId, progress.id));
    expect(delays.length).toBe(1); // não foi apagado em cascata
    expect(delays[0].nextNodeId).toBe(n2);

    const [paymentRow] = await db.select().from(payments).where(eq(payments.id, payment.id));
    expect(paymentRow.nodeId).toBe(n2); // NÃO virou null — PIX pago ainda consegue retomar
  });

  it("nó removido do save é apagado de verdade (delete real, não regressão do diferencial)", async () => {
    const { bot, funnel, n1, n2, progress } = await setupActiveFunnelWithLead();

    // n2 (referenciado pelo lead) some do save — dessa vez o SET NULL/CASCADE é esperado.
    await repo.saveFlow(funnel.id, bot.userId, {
      nodes: [{ id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 }],
      connections: [],
    });

    const db = await testDb();
    const nodes = await db.select().from(funnelNodes).where(eq(funnelNodes.funnelId, funnel.id));
    expect(nodes.map((n) => n.id)).toEqual([n1]);

    const [progressRow] = await db.select().from(leadProgress).where(eq(leadProgress.id, progress.id));
    expect(progressRow.currentNodeId).toBeNull();

    const delays = await db.select().from(scheduledDelays).where(eq(scheduledDelays.progressId, progress.id));
    expect(delays.length).toBe(0); // cascade — esperado pra nó de fato removido
  });

  it("não sequestra id de nó pertencente a OUTRO funil — trata como nó novo e não toca o original", async () => {
    const { funnel: funnelA, n2: nodeOfA } = await setupActiveFunnelWithLead();
    const botB = await createBot();
    const funnelB = await repo.create({ userId: botB.userId, botId: botB.id, name: "B", kind: "flow" });

    // Funil B manda o id de um nó que na verdade pertence ao funil A.
    await repo.saveFlow(funnelB.id, botB.userId, {
      nodes: [{ id: nodeOfA, type: "message", content: { message: "tentativa" }, positionX: 0, positionY: 0 }],
      connections: [],
    });

    const db = await testDb();
    const nodesB = await db.select().from(funnelNodes).where(eq(funnelNodes.funnelId, funnelB.id));
    expect(nodesB.length).toBe(1);
    expect(nodesB[0].id).not.toBe(nodeOfA); // ganhou um id novo, não "roubou" o de A

    const [originalNode] = await db.select().from(funnelNodes).where(eq(funnelNodes.id, nodeOfA));
    expect(originalNode.funnelId).toBe(funnelA.id); // nó original de A intacto
    expect(originalNode.content).toEqual({ message: "olá" }); // conteúdo original, não sobrescrito
  });

  it("rejeita com 409 (APIError aborted) quando expectedUpdatedAt não bate com o funil atual", async () => {
    const bot = await createBot();
    const funnel = await repo.create({ userId: bot.userId, botId: bot.id, name: "F", kind: "flow" });
    const staleTimestamp = funnel.updatedAt.toISOString();

    // Outro save acontece nesse meio tempo (ex.: outra aba) e muda updatedAt.
    await repo.saveFlow(funnel.id, bot.userId, {
      nodes: [{ id: crypto.randomUUID(), type: "trigger", content: {}, positionX: 0, positionY: 0 }],
      connections: [],
    });

    let error: unknown;
    try {
      await repo.saveFlow(funnel.id, bot.userId, {
        nodes: [],
        connections: [],
        expectedUpdatedAt: staleTimestamp,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).code).toBe("aborted");

    // Sem expectedUpdatedAt, comportamento de antes é preservado (sem checagem).
    await expect(repo.saveFlow(funnel.id, bot.userId, { nodes: [], connections: [] }))
      .resolves.toBeUndefined();
  });

  it("aceita quando expectedUpdatedAt bate com o valor atual do funil", async () => {
    const bot = await createBot();
    const funnel = await repo.create({ userId: bot.userId, botId: bot.id, name: "F", kind: "flow" });

    await expect(repo.saveFlow(funnel.id, bot.userId, {
      nodes: [],
      connections: [],
      expectedUpdatedAt: funnel.updatedAt.toISOString(),
    })).resolves.toBeUndefined();
  });
});

describe("FunnelDrizzleRepository.update — checagem otimista opcional (expectedUpdatedAt)", () => {
  it("rejeita com 409 (APIError aborted) quando o funil mudou desde a leitura", async () => {
    const { bot, funnelId } = await newFunnel();
    const db = await testDb();
    const [before] = await db.select().from(funnels).where(eq(funnels.id, funnelId));

    await repo.update(funnelId, bot.userId, { name: "mudou em outra aba" });

    let error: unknown;
    try {
      await repo.update(funnelId, bot.userId, { name: "conflito" }, before.updatedAt);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).code).toBe("aborted");

    const [row] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    expect(row.name).toBe("mudou em outra aba"); // update conflitante não aplicado
  });

  it("aceita quando expectedUpdatedAt bate (sem o campo, comportamento é o de antes)", async () => {
    const { bot, funnelId } = await newFunnel();
    const db = await testDb();
    const [before] = await db.select().from(funnels).where(eq(funnels.id, funnelId));

    const updated = await repo.update(funnelId, bot.userId, { name: "ok" }, before.updatedAt);
    expect(updated.name).toBe("ok");

    await expect(repo.update(funnelId, bot.userId, { name: "sem checagem" })).resolves.toMatchObject({ name: "sem checagem" });
  });
});
