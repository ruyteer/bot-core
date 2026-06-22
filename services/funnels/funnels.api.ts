import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { FunnelDrizzleRepository } from "./infrastructure/funnel.drizzle.repository.js";
import type { FunnelWithBots, FunnelDetail, SaveFlowInput } from "./domain/funnel.entity.js";
import { db } from "../shared/database.js";
import { funnelOffers, leadProgress, payments, funnelNodes, bots } from "../shared/schema/index.js";
import { eq, and, inArray, sql } from "drizzle-orm";

const repo = new FunnelDrizzleRepository();

// ─── Response shapes ─────────────────────────────────────────────────────────

interface FunnelResponse {
  id:        string;
  name:      string;
  kind:      string;
  isActive:  boolean;
  botId:     string | null;
  bots:      { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

interface FunnelDetailResponse extends FunnelResponse {
  nodes: Array<{
    id:        string;
    type:      string;
    content:   Record<string, unknown>;
    positionX: number;
    positionY: number;
  }>;
  connections: Array<{
    id:           string;
    sourceNodeId: string;
    sourceHandle: string | null;
    targetNodeId: string;
  }>;
  simplifiedConfig: Record<string, unknown>;
}

function toResponse(f: FunnelWithBots): FunnelResponse {
  return {
    id:        f.id,
    name:      f.name,
    kind:      f.kind,
    isActive:  f.isActive,
    botId:     f.botId,
    bots:      f.bots,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function toDetailResponse(f: FunnelDetail): FunnelDetailResponse {
  return {
    ...toResponse(f),
    simplifiedConfig: f.simplifiedConfig,
    nodes:       f.nodes.map((n) => ({
      id: n.id, type: n.type, content: n.content,
      positionX: n.positionX, positionY: n.positionY,
    })),
    connections: f.connections.map((c) => ({
      id: c.id, sourceNodeId: c.sourceNodeId,
      sourceHandle: c.sourceHandle, targetNodeId: c.targetNodeId,
    })),
  };
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// GET /funnels?botId=...
export const list = api(
  { method: "GET", path: "/funnels", expose: true, auth: true },
  async ({ botId }: { botId?: string }): Promise<{ funnels: FunnelResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    const result = await repo.findByUserId(userId, botId);
    return { funnels: result.map(toResponse) };
  },
);

// GET /funnels/:id
export const get = api(
  { method: "GET", path: "/funnels/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<FunnelDetailResponse> => {
    const { userID: userId } = getAuthData()!;
    const result = await repo.findByIdOwned(id, userId);
    if (!result) throw APIError.notFound("funnel not found");
    return toDetailResponse(result);
  },
);

// POST /funnels
export const create = api(
  { method: "POST", path: "/funnels", expose: true, auth: true },
  async (req: { name: string; botId: string; kind?: string }): Promise<FunnelResponse> => {
    const { userID: userId } = getAuthData()!;
    const botRow = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, req.botId), eq(bots.userId, userId))).limit(1);
    if (!botRow.length) throw APIError.notFound("bot not found");
    const funnel = await repo.create({
      userId,
      botId: req.botId,
      name:  req.name,
      kind:  req.kind ?? "flow",
    });
    return toResponse({ ...funnel, bots: [{ id: req.botId, name: "" }] });
  },
);

// PATCH /funnels/:id
export const update = api(
  { method: "PATCH", path: "/funnels/:id", expose: true, auth: true },
  async ({ id, ...req }: { id: string; name?: string; botId?: string | null; simplifiedConfig?: Record<string, unknown> }): Promise<FunnelResponse> => {
    const { userID: userId } = getAuthData()!;
    const funnel = await repo.update(id, userId, req);
    const detail = await repo.findByIdOwned(funnel.id, userId);
    if (!detail) throw APIError.notFound("funnel not found");
    return toResponse(detail);
  },
);

// DELETE /funnels/:id
export const remove = api(
  { method: "DELETE", path: "/funnels/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<void> => {
    const { userID: userId } = getAuthData()!;
    await repo.delete(id, userId);
  },
);

// POST /funnels/:id/activate
export const activate = api(
  { method: "POST", path: "/funnels/:id/activate", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await repo.activate(id, userId);
    return { ok: true };
  },
);

// DELETE /funnels/:id/activate
export const deactivate = api(
  { method: "DELETE", path: "/funnels/:id/activate", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await repo.deactivate(id, userId);
    return { ok: true };
  },
);

// PUT /funnels/:id/flow — save nodes + connections (full replace)
export const saveFlow = api(
  { method: "PUT", path: "/funnels/:id/flow", expose: true, auth: true },
  async ({ id, nodes, connections }: { id: string } & SaveFlowInput): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await repo.saveFlow(id, userId, { nodes, connections });
    return { ok: true };
  },
);

// POST /funnels/:id/duplicate
export const duplicate = api(
  { method: "POST", path: "/funnels/:id/duplicate", expose: true, auth: true },
  async ({ id, targetBotId }: { id: string; targetBotId: string }): Promise<FunnelResponse> => {
    const { userID: userId } = getAuthData()!;
    const funnel = await repo.duplicate(id, userId, targetBotId);
    const detail = await repo.findByIdOwned(funnel.id, userId);
    if (!detail) throw APIError.notFound("funnel not found");
    return toResponse(detail);
  },
);

// GET /funnels/:id/stats
export const stats = api(
  { method: "GET", path: "/funnels/:id/stats", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{
    funnelName: string;
    funnelKind: string;
    totalLeads: number;
    activeLeads: number;
    completedLeads: number;
    revenue: number;
    sales: number;
    nodeStats: Array<{ nodeId: string; nodeType: string; label: string; count: number }>;
  }> => {
    const { userID: userId } = getAuthData()!;
    const funnel = await repo.findByIdOwned(id, userId);
    if (!funnel) throw APIError.notFound("funnel not found");

    const [offerRows, progressRows] = await Promise.all([
      db.select({ id: funnelOffers.id }).from(funnelOffers).where(eq(funnelOffers.funnelId, id)),
      db.select({ leadId: leadProgress.leadId, currentNodeId: leadProgress.currentNodeId, status: leadProgress.status })
        .from(leadProgress).where(eq(leadProgress.funnelId, id)),
    ]);

    const offerIds = offerRows.map((o) => o.id);
    let revenue = 0;
    let sales = 0;
    if (offerIds.length > 0) {
      const paidRows = await db.select({ amount: payments.amount })
        .from(payments)
        .where(and(inArray(payments.offerId, offerIds), eq(payments.status, "paid")));
      revenue = paidRows.reduce((sum, p) => sum + p.amount, 0);
      sales = paidRows.length;
    }

    const totalLeads = progressRows.length;
    const activeLeads = progressRows.filter((r) => r.status === "active").length;
    const completedLeads = progressRows.filter((r) => r.status === "completed").length;

    const nodeCounts = new Map<string, number>();
    progressRows.forEach((r) => {
      if (r.currentNodeId) nodeCounts.set(r.currentNodeId, (nodeCounts.get(r.currentNodeId) ?? 0) + 1);
    });

    let nodeStats: Array<{ nodeId: string; nodeType: string; label: string; count: number }> = [];
    if (nodeCounts.size > 0) {
      const nodeRows = await db.select({ id: funnelNodes.id, type: funnelNodes.type, content: funnelNodes.content })
        .from(funnelNodes).where(inArray(funnelNodes.id, [...nodeCounts.keys()]));
      nodeStats = nodeRows.map((n) => {
        const content = n.content as Record<string, unknown>;
        const label = (content?.label as string | undefined) ?? n.type;
        return { nodeId: n.id, nodeType: n.type, label, count: nodeCounts.get(n.id) ?? 0 };
      }).sort((a, b) => b.count - a.count);
    }

    return { funnelName: funnel.name, funnelKind: funnel.kind, totalLeads, activeLeads, completedLeads, revenue, sales, nodeStats };
  },
);

// GET /funnels/offers?botId=... — list funnel offers for a bot (used by broadcasts/remarketing)
export const listOffers = api(
  { method: "GET", path: "/funnels/offers", expose: true, auth: true },
  async ({ botId }: { botId?: string }): Promise<{ offers: Array<{ id: string; name: string; price: number; externalRef: string | null; botId: string; scope: string }> }> => {
    const { userID: userId } = getAuthData()!;
    const userBots = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
    const allowedBotIds = new Set(userBots.map((b) => b.id));

    if (botId && !allowedBotIds.has(botId)) throw APIError.notFound("bot not found");

    const targetBotIds = botId ? [botId] : [...allowedBotIds];
    if (targetBotIds.length === 0) return { offers: [] };

    const rows = await db.select().from(funnelOffers)
      .where(and(inArray(funnelOffers.botId, targetBotIds), eq(funnelOffers.isActive, true)));

    return {
      offers: rows.map((o) => ({
        id:          o.id,
        name:        o.name,
        price:       o.price,
        externalRef: o.externalRef,
        botId:       o.botId,
        scope:       o.scope,
      })),
    };
  },
);

// POST /funnels/offers — create a single funnel offer
export const createOffer = api(
  { method: "POST", path: "/funnels/offers", expose: true, auth: true },
  async (req: {
    botId:            string;
    name:             string;
    price:            number;
    productType?:     string;
    deliveryUrl?:     string | null;
    deliveryText?:    string | null;
    telegramGroupId?: string | null;
    accessDays?:      number;
    externalRef?:     string | null;
    scope?:           string;
    isActive?:        boolean;
  }): Promise<{ id: string; name: string; price: number; botId: string; externalRef: string | null }> => {
    const { userID: userId } = getAuthData()!;
    const bot = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, req.botId), eq(bots.userId, userId))).limit(1);
    if (!bot.length) throw APIError.notFound("bot not found");

    const [row] = await db.insert(funnelOffers).values({
      botId:           req.botId,
      name:            req.name.trim(),
      price:           req.price,
      productType:     req.productType ?? "digital",
      deliveryUrl:     req.deliveryUrl ?? null,
      deliveryText:    req.deliveryText ?? null,
      telegramGroupId: req.telegramGroupId ?? null,
      accessDays:      req.accessDays ?? 0,
      externalRef:     req.externalRef ?? null,
      scope:           req.scope ?? "global",
      isActive:        req.isActive ?? true,
    }).returning();

    return { id: row.id, name: row.name, price: row.price, botId: row.botId, externalRef: row.externalRef };
  },
);

// POST /funnels/offers/bulk — create multiple funnel offers (for cross-bot replication)
export const createOffersBulk = api(
  { method: "POST", path: "/funnels/offers/bulk", expose: true, auth: true },
  async ({ offers }: { offers: Array<{ botId: string; name: string; price: number; productType?: string; deliveryUrl?: string | null; deliveryText?: string | null; telegramGroupId?: string | null; accessDays?: number; externalRef?: string | null; scope?: string; isActive?: boolean }> }): Promise<{ offers: Array<{ id: string; name: string; price: number; botId: string }> }> => {
    const { userID: userId } = getAuthData()!;
    if (offers.length === 0) return { offers: [] };

    const userBots = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
    const allowedIds = new Set(userBots.map((b) => b.id));
    if (!offers.every((o) => allowedIds.has(o.botId))) throw APIError.permissionDenied("bot not owned");

    const rows = await db.insert(funnelOffers).values(
      offers.map((o) => ({
        botId:           o.botId,
        name:            o.name.trim(),
        price:           o.price,
        productType:     o.productType ?? "digital",
        deliveryUrl:     o.deliveryUrl ?? null,
        deliveryText:    o.deliveryText ?? null,
        telegramGroupId: o.telegramGroupId ?? null,
        accessDays:      o.accessDays ?? 0,
        externalRef:     o.externalRef ?? null,
        scope:           o.scope ?? "global",
        isActive:        o.isActive ?? true,
      }))
    ).returning();

    return { offers: rows.map((r) => ({ id: r.id, name: r.name, price: r.price, botId: r.botId })) };
  },
);

// PUT /funnels/:id/bots — replace bot assignments
export const assignBots = api(
  { method: "PUT", path: "/funnels/:id/bots", expose: true, auth: true },
  async ({ id, botIds }: { id: string; botIds: string[] }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await repo.assignBots(id, userId, botIds);
    return { ok: true };
  },
);
