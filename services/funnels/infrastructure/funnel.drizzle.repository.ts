import { randomUUID } from "node:crypto";
import { eq, and, inArray, ne } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  funnels, funnelBots, funnelNodes, nodeConnections, bots,
  scheduledDelays, funnelOffers, leadProgress,
} from "../../shared/schema/index.js";
import type { FunnelRepository } from "../domain/funnel.repository.js";
import type { Funnel, FunnelWithBots, FunnelDetail, CreateFunnelInput, SaveFlowInput } from "../domain/funnel.entity.js";

export class FunnelDrizzleRepository implements FunnelRepository {
  private toFunnel(row: typeof funnels.$inferSelect): Funnel {
    return {
      id:               row.id,
      userId:           row.userId,
      botId:            row.botId,
      name:             row.name,
      kind:             row.kind,
      isActive:         row.isActive,
      simplifiedConfig: (row.simplifiedConfig as Record<string, unknown>) ?? {},
      createdAt:        row.createdAt,
      updatedAt:        row.updatedAt,
    };
  }

  private async attachBots(funnelList: Funnel[]): Promise<FunnelWithBots[]> {
    if (funnelList.length === 0) return [];
    const ids = funnelList.map((f) => f.id);
    const links = await db
      .select({ funnelId: funnelBots.funnelId, botId: funnelBots.botId, botName: bots.name })
      .from(funnelBots)
      .innerJoin(bots, eq(funnelBots.botId, bots.id))
      .where(inArray(funnelBots.funnelId, ids));

    const grouped = new Map<string, { id: string; name: string }[]>();
    for (const l of links) {
      const arr = grouped.get(l.funnelId) ?? [];
      arr.push({ id: l.botId, name: l.botName });
      grouped.set(l.funnelId, arr);
    }
    return funnelList.map((f) => ({ ...f, bots: grouped.get(f.id) ?? [] }));
  }

  async findByUserId(userId: string, botId?: string): Promise<FunnelWithBots[]> {
    const rows = botId
      ? await db.select().from(funnels).where(and(eq(funnels.userId, userId), eq(funnels.botId, botId)))
      : await db.select().from(funnels).where(eq(funnels.userId, userId));
    return this.attachBots(rows.map((r) => this.toFunnel(r)));
  }

  async findById(id: string): Promise<FunnelDetail | null> {
    const [row] = await db.select().from(funnels).where(eq(funnels.id, id));
    if (!row) return null;
    return this.toDetail(this.toFunnel(row));
  }

  async findByIdOwned(id: string, userId: string): Promise<FunnelDetail | null> {
    const [row] = await db.select().from(funnels).where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
    if (!row) return null;
    return this.toDetail(this.toFunnel(row));
  }

  private async toDetail(funnel: Funnel): Promise<FunnelDetail> {
    const [withBots] = await this.attachBots([funnel]);
    const nodes  = await db.select().from(funnelNodes).where(eq(funnelNodes.funnelId, funnel.id));
    const conns  = await db.select().from(nodeConnections).where(eq(nodeConnections.funnelId, funnel.id));
    return {
      ...withBots,
      nodes: nodes.map((n) => ({
        id:        n.id,
        funnelId:  n.funnelId,
        type:      n.type,
        content:   (n.content as Record<string, unknown>) ?? {},
        positionX: n.positionX,
        positionY: n.positionY,
      })),
      connections: conns.map((c) => ({
        id:           c.id,
        funnelId:     c.funnelId,
        sourceNodeId: c.sourceNodeId,
        sourceHandle: c.sourceHandle,
        targetNodeId: c.targetNodeId,
      })),
    };
  }

  async create(input: CreateFunnelInput): Promise<Funnel> {
    const [row] = await db.insert(funnels).values({
      userId: input.userId,
      botId:  input.botId,
      name:   input.name,
      kind:   input.kind,
    }).returning();
    // Auto-add to funnel_bots
    await db.insert(funnelBots).values({ funnelId: row.id, botId: input.botId }).onConflictDoNothing();
    return this.toFunnel(row);
  }

  async update(id: string, userId: string, data: Partial<Pick<Funnel, "name" | "isActive" | "simplifiedConfig" | "botId">>): Promise<Funnel> {
    const [row] = await db.update(funnels)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.simplifiedConfig !== undefined && { simplifiedConfig: data.simplifiedConfig }),
        ...(data.botId !== undefined && { botId: data.botId }),
        updatedAt: new Date(),
      })
      .where(and(eq(funnels.id, id), eq(funnels.userId, userId)))
      .returning();
    return this.toFunnel(row);
  }

  async delete(id: string, userId: string): Promise<void> {
    // Cascade handled by FK, but scheduled_delays FK has no cascade — delete explicitly
    await db.delete(scheduledDelays).where(eq(scheduledDelays.funnelId, id));
    await db.delete(funnelOffers).where(eq(funnelOffers.funnelId, id));
    await db.delete(leadProgress).where(eq(leadProgress.funnelId, id));
    await db.delete(funnels).where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
  }

  async saveFlow(id: string, userId: string, input: SaveFlowInput): Promise<void> {
    // Verify ownership
    const [row] = await db.select({ id: funnels.id }).from(funnels)
      .where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
    if (!row) throw new Error("funnel not found");

    const validTypes = ["trigger","message","media","audio","buttons","input","delay","condition","random","offer","wait_response"] as const;
    type NodeType = typeof validTypes[number];

    // As colunas de id são uuid, mas o React Flow gera ids tipo "xy-edge__..."
    // para conexões desenhadas à mão. Regenera server-side qualquer id inválido
    // (remapeando as referências das conexões quando for id de nó).
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const nodeIdMap = new Map<string, string>();
    for (const n of input.nodes) nodeIdMap.set(n.id, isUuid(n.id) ? n.id : randomUUID());

    // Full replace dentro de UMA transação: se qualquer insert falhar, o fluxo
    // antigo permanece intacto (antes, um erro no meio apagava as conexões).
    await db.transaction(async (tx) => {
      await tx.delete(nodeConnections).where(eq(nodeConnections.funnelId, id));
      await tx.delete(funnelNodes).where(eq(funnelNodes.funnelId, id));

      if (input.nodes.length > 0) {
        await tx.insert(funnelNodes).values(input.nodes.map((n) => ({
          id:        nodeIdMap.get(n.id)!,
          funnelId:  id,
          type:      (validTypes.includes(n.type as NodeType) ? n.type : "message") as NodeType,
          content:   n.content,
          positionX: n.positionX,
          positionY: n.positionY,
        })));
      }

      if (input.connections.length > 0) {
        await tx.insert(nodeConnections).values(input.connections.map((c) => ({
          id:           isUuid(c.id) ? c.id : randomUUID(),
          funnelId:     id,
          sourceNodeId: nodeIdMap.get(c.sourceNodeId) ?? c.sourceNodeId,
          sourceHandle: c.sourceHandle,
          targetNodeId: nodeIdMap.get(c.targetNodeId) ?? c.targetNodeId,
        })));
      }

      await tx.update(funnels).set({ updatedAt: new Date() }).where(eq(funnels.id, id));
    });
  }

  async activate(id: string, userId: string): Promise<void> {
    const [row] = await db.select({ botId: funnels.botId }).from(funnels)
      .where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
    if (!row) throw new Error("funnel not found");
    if (row.botId) {
      // Deactivate all other funnels for this bot first
      await db.update(funnels)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(funnels.botId, row.botId), ne(funnels.id, id)));
    }
    await db.update(funnels).set({ isActive: true, updatedAt: new Date() })
      .where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
  }

  async deactivate(id: string, userId: string): Promise<void> {
    await db.update(funnels).set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
  }

  async duplicate(id: string, userId: string, targetBotId: string): Promise<Funnel> {
    const source = await this.findByIdOwned(id, userId);
    if (!source) throw new Error("funnel not found");

    const [newFunnel] = await db.insert(funnels).values({
      userId:  userId,
      botId:   targetBotId,
      name:    `${source.name} (cópia)`,
      kind:    source.kind,
      isActive: false,
      simplifiedConfig: source.simplifiedConfig,
    }).returning();

    await db.insert(funnelBots).values({ funnelId: newFunnel.id, botId: targetBotId }).onConflictDoNothing();

    // Remap node IDs
    const idMap = new Map<string, string>();
    if (source.nodes.length > 0) {
      const newNodes = source.nodes.map((n) => {
        const newId = crypto.randomUUID();
        idMap.set(n.id, newId);
        const validTypes = ["trigger","message","media","audio","buttons","input","delay","condition","random","offer","wait_response"] as const;
        type NodeType = typeof validTypes[number];
        return {
          id:        newId,
          funnelId:  newFunnel.id,
          type:      (validTypes.includes(n.type as NodeType) ? n.type : "message") as NodeType,
          content:   n.content,
          positionX: n.positionX,
          positionY: n.positionY,
        };
      });
      await db.insert(funnelNodes).values(newNodes);
    }

    if (source.connections.length > 0) {
      const validConns = source.connections.filter(
        (c) => idMap.has(c.sourceNodeId) && idMap.has(c.targetNodeId)
      );
      if (validConns.length > 0) {
        await db.insert(nodeConnections).values(validConns.map((c) => ({
          id:           crypto.randomUUID(),
          funnelId:     newFunnel.id,
          sourceNodeId: idMap.get(c.sourceNodeId)!,
          sourceHandle: c.sourceHandle,
          targetNodeId: idMap.get(c.targetNodeId)!,
        })));
      }
    }

    return this.toFunnel(newFunnel);
  }

  async assignBots(id: string, userId: string, botIds: string[]): Promise<void> {
    const [row] = await db.select({ id: funnels.id }).from(funnels)
      .where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
    if (!row) throw new Error("funnel not found");
    await db.delete(funnelBots).where(eq(funnelBots.funnelId, id));
    if (botIds.length > 0) {
      await db.insert(funnelBots).values(botIds.map((botId) => ({ funnelId: id, botId }))).onConflictDoNothing();
    }
  }

  async findActiveFunnelByBotId(botId: string): Promise<FunnelDetail | null> {
    const [row] = await db.select().from(funnels)
      .where(and(eq(funnels.botId, botId), eq(funnels.isActive, true)));
    if (!row) return null;
    return this.toDetail(this.toFunnel(row));
  }
}
