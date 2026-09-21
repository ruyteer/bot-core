import { randomUUID } from "node:crypto";
import { eq, and, inArray, ne, or, desc } from "drizzle-orm";
import { APIError } from "encore.dev/api";
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

  async update(id: string, userId: string, data: Partial<Pick<Funnel, "name" | "simplifiedConfig" | "botId">>, expectedUpdatedAt?: Date): Promise<Funnel> {
    // Checagem otimista opcional (mesma ideia do `saveFlow` abaixo): sem
    // `expectedUpdatedAt`, comportamento idêntico ao anterior. Check-then-act
    // sem lock/transação — mesma janela de corrida já aceita em `activate()`
    // (ver comentário lá); o pior caso aqui é o mesmo 409 "falso negativo" raro.
    if (expectedUpdatedAt) {
      const [current] = await db.select({ updatedAt: funnels.updatedAt }).from(funnels)
        .where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
      if (!current) throw APIError.notFound("funnel not found");
      if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        throw APIError.aborted("funil foi alterado por outra sessão desde que foi carregado — recarregue antes de salvar");
      }
    }

    const [row] = await db.update(funnels)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.simplifiedConfig !== undefined && { simplifiedConfig: data.simplifiedConfig }),
        ...(data.botId !== undefined && { botId: data.botId }),
        updatedAt: new Date(),
      })
      .where(and(eq(funnels.id, id), eq(funnels.userId, userId)))
      .returning();
    if (!row) throw APIError.notFound("funnel not found");
    return this.toFunnel(row);
  }

  async delete(id: string, userId: string): Promise<void> {
    // Cascade handled by FK, but scheduled_delays FK has no cascade — delete explicitly
    await db.delete(scheduledDelays).where(eq(scheduledDelays.funnelId, id));
    await db.delete(funnelOffers).where(eq(funnelOffers.funnelId, id));
    await db.delete(leadProgress).where(eq(leadProgress.funnelId, id));
    await db.delete(funnels).where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
  }

  async saveFlow(id: string, userId: string, input: SaveFlowInput): Promise<Date> {
    const validTypes = ["trigger","message","media","audio","buttons","input","delay","condition","random","offer","wait_response"] as const;
    type NodeType = typeof validTypes[number];

    // As colunas de id são uuid, mas o React Flow gera ids tipo "xy-edge__..."
    // para conexões desenhadas à mão. Regenera server-side qualquer id inválido
    // (remapeando as referências das conexões quando for id de nó).
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

    // Save DIFERENCIAL numa transação (era full delete+insert: apagava e
    // recriava TODOS os nós a cada save, mesmo preservando os ids nos
    // inserts). As FKs reagem ao DELETE mesmo quando o INSERT devolve o id
    // igual — o registro é outro fisicamente:
    //   - lead_progress.current_node_id  → SET NULL (leads perdiam a posição)
    //   - scheduled_delays.next_node_id  → CASCADE  (delay agendado sumia)
    //   - payments.node_id               → SET NULL (retomada de PIX pago quebrava)
    //   - funnel_offers.node_id          → SET NULL
    // Ou seja: qualquer autosave de um funil ATIVO tirava leads da posição,
    // apagava delays agendados e podia impedir um PIX pago de retomar o
    // funil. Ver bug reportado — corrige fazendo UPDATE dos nós que
    // continuam existindo (mesmo id, mesmo funil), INSERT só dos novos e
    // DELETE só dos removidos.
    return db.transaction(async (tx) => {
      // Ownership + checagem otimista de concorrência dentro da MESMA transação
      // do resto do save, pra ler `updatedAt` no mesmo snapshot que o diff usa.
      const [row] = await tx.select({ id: funnels.id, updatedAt: funnels.updatedAt }).from(funnels)
        .where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
      if (!row) throw APIError.notFound("funnel not found");

      if (input.expectedUpdatedAt) {
        const expected = new Date(input.expectedUpdatedAt).getTime();
        if (expected !== row.updatedAt.getTime()) {
          throw APIError.aborted("funil foi alterado por outra sessão desde que foi carregado — recarregue antes de salvar");
        }
      }

      // Nós que já existem NESTE funil — base do diff update/insert/delete.
      const existingRows = await tx.select({ id: funnelNodes.id }).from(funnelNodes)
        .where(eq(funnelNodes.funnelId, id));
      const existingIds = new Set(existingRows.map((r) => r.id));

      // Um uuid de entrada pode: (a) já ser um nó deste funil → update; (b) já
      // existir mas pertencer a OUTRO funil → nunca reaproveita esse registro
      // (evita um funil "sequestrar" nó de outro só mandando o id certo) —
      // trata como nó novo, gerando outro id; (c) não existir em lugar nenhum
      // → nó novo de verdade, mantém o uuid que o cliente já gerou.
      const candidateUuids = [...new Set(input.nodes.map((n) => n.id).filter(isUuid))];
      const foreignRows = candidateUuids.length > 0
        ? await tx.select({ id: funnelNodes.id, funnelId: funnelNodes.funnelId }).from(funnelNodes)
            .where(inArray(funnelNodes.id, candidateUuids))
        : [];
      const foreignFunnelById = new Map(foreignRows.map((r) => [r.id, r.funnelId]));

      const nodeIdMap = new Map<string, string>();
      for (const n of input.nodes) {
        if (isUuid(n.id) && existingIds.has(n.id)) {
          nodeIdMap.set(n.id, n.id);
        } else if (isUuid(n.id) && foreignFunnelById.has(n.id) && foreignFunnelById.get(n.id) !== id) {
          nodeIdMap.set(n.id, randomUUID());
        } else if (isUuid(n.id)) {
          nodeIdMap.set(n.id, n.id);
        } else {
          nodeIdMap.set(n.id, randomUUID());
        }
      }

      const keepIds = new Set([...nodeIdMap.values()].filter((finalId) => existingIds.has(finalId)));
      const deleteIds = [...existingIds].filter((existingId) => !keepIds.has(existingId));

      // Arestas: nenhuma outra tabela tem FK pra `node_connections.id` (só pra
      // `funnel_nodes.id`, que tem os 4 FKs listados acima) — apagar e
      // recriar todas não perde nenhuma referência externa. Mantém o
      // full-replace aqui, mais simples que diferenciar sem ganho nenhum.
      await tx.delete(nodeConnections).where(eq(nodeConnections.funnelId, id));

      if (deleteIds.length > 0) {
        await tx.delete(funnelNodes).where(and(eq(funnelNodes.funnelId, id), inArray(funnelNodes.id, deleteIds)));
      }

      for (const n of input.nodes) {
        const finalId = nodeIdMap.get(n.id)!;
        if (!keepIds.has(finalId)) continue;
        await tx.update(funnelNodes).set({
          type:      (validTypes.includes(n.type as NodeType) ? n.type : "message") as NodeType,
          content:   n.content,
          positionX: n.positionX,
          positionY: n.positionY,
          updatedAt: new Date(),
        }).where(eq(funnelNodes.id, finalId));
      }

      const newNodes = input.nodes.filter((n) => !keepIds.has(nodeIdMap.get(n.id)!));
      if (newNodes.length > 0) {
        await tx.insert(funnelNodes).values(newNodes.map((n) => ({
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

      const savedAt = new Date();
      await tx.update(funnels).set({ updatedAt: savedAt }).where(eq(funnels.id, id));
      return savedAt;
    });
  }

  async activate(id: string, userId: string): Promise<void> {
    const [row] = await db.select({ botId: funnels.botId }).from(funnels)
      .where(and(eq(funnels.id, id), eq(funnels.userId, userId)));
    if (!row) throw new Error("funnel not found");

    // "Um funil ativo por bot" precisa valer para TODOS os bots deste funil,
    // não só para o primário. Enquanto olhava apenas `funnels.bot_id`, ativar
    // um funil vinculado por `funnel_bots` não desativava o concorrente — os
    // dois ficavam ativos para o mesmo bot e quem respondia dependia da ordem
    // que o banco devolvesse. É a outra metade do "só funciona reativando".
    const linked = await db.select({ botId: funnelBots.botId }).from(funnelBots)
      .where(eq(funnelBots.funnelId, id));
    const botIds = [...new Set([row.botId, ...linked.map((l) => l.botId)].filter(
      (b): b is string => typeof b === "string" && b.length > 0,
    ))];

    if (botIds.length > 0) {
      await db.update(funnels)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(
          ne(funnels.id, id),
          or(
            inArray(funnels.botId, botIds),
            inArray(
              funnels.id,
              db.select({ id: funnelBots.funnelId }).from(funnelBots)
                .where(inArray(funnelBots.botId, botIds)),
            ),
          ),
        ));
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
    // Mesmo predicado do runner: o vínculo funil↔bot existe em duas vias, e
    // `assignBots()` só escreve na tabela `funnel_bots`. Ver `belongsToBot`
    // em execute-flow-step.use-case.ts.
    const [row] = await db.select().from(funnels)
      .where(and(
        or(
          eq(funnels.botId, botId),
          inArray(
            funnels.id,
            db.select({ id: funnelBots.funnelId }).from(funnelBots).where(eq(funnelBots.botId, botId)),
          ),
        ),
        eq(funnels.isActive, true),
      ))
      // Sem ordem explícita, "qual funil ativo vence" era o que o Postgres
      // devolvesse primeiro — não-determinístico entre execuções.
      .orderBy(desc(funnels.updatedAt))
      .limit(1);
    if (!row) return null;
    return this.toDetail(this.toFunnel(row));
  }
}
