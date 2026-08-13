import { api, APIError } from "encore.dev/api";
import { scanSourceAsync } from "../compliance/application/scan.js";
import { getAuthData } from "~encore/auth";
import { db } from "../shared/database.js";
import { remarketingCampaigns, remarketingMessages, remarketingLeadState, bots, leads, payments } from "../shared/schema/index.js";
import { eq, and, inArray, desc, sql } from "drizzle-orm";

// ─── Response shapes ─────────────────────────────────────────────────────────

interface CampaignResponse {
  id:              string;
  botId:           string;
  botIds:          string[];
  name:            string;
  triggerType:     string;
  triggerConfig:   unknown;
  filterType:      string;
  advancedFilters: unknown;
  targetGroupIds:  string[];
  stopOnPurchase:  boolean;
  stopOnReply:     boolean;
  maxCycles:       number | null;
  isActive:        boolean;
  totalEnrolled:   number;
  totalMessagesSent: number;
  messageCount:    number;
  leadStateStats:  { active: number; paused: number; completed: number };
  createdAt:       string;
}

interface MessageResponse {
  id:            string;
  campaignId:    string;
  message:       string;
  media:         unknown;
  inlineButtons: unknown;
  offerId:       string | null;
  delayValue:    number;
  delayUnit:     string;
  orderIndex:    number;
}

function toCampaignResponse(
  c: typeof remarketingCampaigns.$inferSelect,
  messageCount = 0,
  stats = { active: 0, paused: 0, completed: 0 },
  counters?: { totalEnrolled: number; totalMessagesSent: number },
): CampaignResponse {
  return {
    id:               c.id,
    botId:            c.botId,
    botIds:           (c.botIds as string[]) ?? [],
    name:             c.name,
    triggerType:      c.triggerType,
    triggerConfig:    c.triggerConfig,
    filterType:       c.filterType,
    advancedFilters:  c.advancedFilters,
    targetGroupIds:   (c.targetGroupIds as string[]) ?? [],
    stopOnPurchase:   c.stopOnPurchase,
    stopOnReply:      c.stopOnReply,
    maxCycles:        c.maxCycles,
    isActive:         c.isActive,
    // Derivados de remarketing_lead_state (fonte de verdade) — as colunas na tabela
    // de campanhas ficam desatualizadas por concorrência entre réplicas.
    totalEnrolled:    counters?.totalEnrolled ?? c.totalEnrolled,
    totalMessagesSent: counters?.totalMessagesSent ?? c.totalMessagesSent,
    messageCount,
    leadStateStats:   stats,
    createdAt:        c.createdAt.toISOString(),
  };
}

// Deriva enrolled/messagesSent a partir de remarketing_lead_state para um conjunto de campanhas,
// em uma única query agregada (evita N+1). remarketing_lead_state é a fonte de verdade:
// as colunas totalEnrolled/totalMessagesSent em remarketing_campaigns podem ficar desatualizadas.
async function getCampaignCounters(campaignIds: string[]): Promise<Map<string, { totalEnrolled: number; totalMessagesSent: number }>> {
  const map = new Map<string, { totalEnrolled: number; totalMessagesSent: number }>();
  if (campaignIds.length === 0) return map;

  const rows = await db.select({
    campaignId:        remarketingLeadState.campaignId,
    totalEnrolled:      sql<number>`count(*)::int`,
    totalMessagesSent: sql<number>`coalesce(sum(${remarketingLeadState.totalSent}), 0)::int`,
  })
    .from(remarketingLeadState)
    .where(inArray(remarketingLeadState.campaignId, campaignIds))
    .groupBy(remarketingLeadState.campaignId);

  for (const r of rows) {
    map.set(r.campaignId, { totalEnrolled: r.totalEnrolled, totalMessagesSent: r.totalMessagesSent });
  }
  return map;
}

function toMessageResponse(m: typeof remarketingMessages.$inferSelect): MessageResponse {
  return {
    id:            m.id,
    campaignId:    m.campaignId,
    message:       m.message,
    media:         m.media,
    inlineButtons: m.inlineButtons,
    offerId:       m.offerId,
    delayValue:    m.delayValue,
    delayUnit:     m.delayUnit,
    orderIndex:    m.orderIndex,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getUserBotIds(userId: string): Promise<string[]> {
  const rows = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
  return rows.map((b) => b.id);
}

async function assertCampaignOwnership(campaignId: string, userId: string): Promise<typeof remarketingCampaigns.$inferSelect> {
  const [c] = await db.select().from(remarketingCampaigns).where(eq(remarketingCampaigns.id, campaignId)).limit(1);
  if (!c) throw APIError.notFound("campaign not found");
  const botRows = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, c.botId), eq(bots.userId, userId))).limit(1);
  if (!botRows.length) throw APIError.notFound("campaign not found");
  return c;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// GET /remarketing?botId=...
export const list = api(
  { method: "GET", path: "/remarketing", expose: true, auth: true },
  async ({ botId }: { botId?: string }): Promise<{ campaigns: CampaignResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    if (botId) {
      const row = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, botId), eq(bots.userId, userId))).limit(1);
      if (!row.length) throw APIError.notFound("bot not found");
    }
    const botIds = botId ? [botId] : await getUserBotIds(userId);
    if (botIds.length === 0) return { campaigns: [] };

    const campaigns = await db.select().from(remarketingCampaigns)
      .where(inArray(remarketingCampaigns.botId, botIds))
      .orderBy(desc(remarketingCampaigns.createdAt));

    if (campaigns.length === 0) return { campaigns: [] };

    const ids = campaigns.map((c) => c.id);
    const [msgCounts, statRows, countersMap] = await Promise.all([
      db.select({ campaignId: remarketingMessages.campaignId, count: sql<number>`count(*)::int` })
        .from(remarketingMessages).where(inArray(remarketingMessages.campaignId, ids))
        .groupBy(remarketingMessages.campaignId),
      db.select({ campaignId: remarketingLeadState.campaignId, status: remarketingLeadState.status, count: sql<number>`count(*)::int` })
        .from(remarketingLeadState).where(inArray(remarketingLeadState.campaignId, ids))
        .groupBy(remarketingLeadState.campaignId, remarketingLeadState.status),
      getCampaignCounters(ids),
    ]);

    const msgMap = new Map(msgCounts.map((r) => [r.campaignId, r.count]));
    const statsMap = new Map<string, { active: number; paused: number; completed: number }>();
    for (const r of statRows) {
      const s = statsMap.get(r.campaignId) || { active: 0, paused: 0, completed: 0 };
      if (r.status === "active") s.active = r.count;
      else if (r.status === "paused") s.paused = r.count;
      else if (r.status === "completed") s.completed = r.count;
      statsMap.set(r.campaignId, s);
    }

    return {
      campaigns: campaigns.map((c) =>
        toCampaignResponse(c, msgMap.get(c.id) ?? 0, statsMap.get(c.id) ?? { active: 0, paused: 0, completed: 0 }, countersMap.get(c.id))
      ),
    };
  },
);

// GET /remarketing/:id
export const get = api(
  { method: "GET", path: "/remarketing/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<CampaignResponse & { messages: MessageResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    const c = await assertCampaignOwnership(id, userId);
    const messages = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, id)).orderBy(remarketingMessages.orderIndex);
    const counters = (await getCampaignCounters([id])).get(id);
    return { ...toCampaignResponse(c, messages.length, undefined, counters), messages: messages.map(toMessageResponse) };
  },
);

// POST /remarketing
export const create = api(
  { method: "POST", path: "/remarketing", expose: true, auth: true },
  async (req: {
    botId: string;
    botIds?: string[];
    name: string;
    triggerType?: string;
    triggerConfig?: unknown;
    filterType?: string;
    advancedFilters?: unknown;
    targetGroupIds?: string[];
    stopOnPurchase?: boolean;
    stopOnReply?: boolean;
    maxCycles?: number | null;
    isActive?: boolean;
  }): Promise<CampaignResponse> => {
    const { userID: userId } = getAuthData()!;
    const botRows = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, req.botId), eq(bots.userId, userId))).limit(1);
    if (!botRows.length) throw APIError.notFound("bot not found");

    const [c] = await db.insert(remarketingCampaigns).values({
      botId:           req.botId,
      botIds:          req.botIds ?? [req.botId],
      name:            req.name,
      triggerType:     req.triggerType ?? "manual",
      triggerConfig:   req.triggerConfig ?? {},
      filterType:      req.filterType ?? "all",
      advancedFilters: req.advancedFilters ?? {},
      targetGroupIds:  req.targetGroupIds ?? [],
      stopOnPurchase:  req.stopOnPurchase ?? true,
      stopOnReply:     req.stopOnReply ?? false,
      maxCycles:       req.maxCycles ?? null,
      isActive:        req.isActive ?? false,
    }).returning();

    scanSourceAsync("remarketing", c.id);
    return toCampaignResponse(c);
  },
);

// PATCH /remarketing/:id
export const update = api(
  { method: "PATCH", path: "/remarketing/:id", expose: true, auth: true },
  async ({ id, ...req }: {
    id: string;
    name?: string;
    triggerType?: string;
    triggerConfig?: unknown;
    filterType?: string;
    advancedFilters?: unknown;
    targetGroupIds?: string[];
    stopOnPurchase?: boolean;
    stopOnReply?: boolean;
    maxCycles?: number | null;
    isActive?: boolean;
    botIds?: string[];
  }): Promise<CampaignResponse> => {
    const { userID: userId } = getAuthData()!;
    await assertCampaignOwnership(id, userId);

    const patch: Partial<typeof remarketingCampaigns.$inferInsert> = { updatedAt: new Date() };
    if (req.name !== undefined)            patch.name = req.name;
    if (req.triggerType !== undefined)     patch.triggerType = req.triggerType;
    if (req.triggerConfig !== undefined)   patch.triggerConfig = req.triggerConfig;
    if (req.filterType !== undefined)      patch.filterType = req.filterType;
    if (req.advancedFilters !== undefined) patch.advancedFilters = req.advancedFilters;
    if (req.targetGroupIds !== undefined)  patch.targetGroupIds = req.targetGroupIds;
    if (req.stopOnPurchase !== undefined)  patch.stopOnPurchase = req.stopOnPurchase;
    if (req.stopOnReply !== undefined)     patch.stopOnReply = req.stopOnReply;
    if ("maxCycles" in req)                patch.maxCycles = req.maxCycles;
    if (req.isActive !== undefined)        patch.isActive = req.isActive;
    if (req.botIds !== undefined)          patch.botIds = req.botIds;

    const [updated] = await db.update(remarketingCampaigns).set(patch).where(eq(remarketingCampaigns.id, id)).returning();
    scanSourceAsync("remarketing", id);
    const msgCount = await db.select({ count: sql<number>`count(*)::int` }).from(remarketingMessages).where(eq(remarketingMessages.campaignId, id));
    const counters = (await getCampaignCounters([id])).get(id);
    return toCampaignResponse(updated, msgCount[0]?.count ?? 0, undefined, counters);
  },
);

// DELETE /remarketing/:id
export const remove = api(
  { method: "DELETE", path: "/remarketing/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<void> => {
    const { userID: userId } = getAuthData()!;
    await assertCampaignOwnership(id, userId);
    await db.delete(remarketingCampaigns).where(eq(remarketingCampaigns.id, id));
  },
);

// POST /remarketing/:id/duplicate
export const duplicateCampaign = api(
  { method: "POST", path: "/remarketing/:id/duplicate", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<CampaignResponse> => {
    const { userID: userId } = getAuthData()!;
    const original = await assertCampaignOwnership(id, userId);
    const messages = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, id)).orderBy(remarketingMessages.orderIndex);

    const [newCampaign] = await db.insert(remarketingCampaigns).values({
      ...original,
      id: undefined as any,
      name:        original.name + " (cópia)",
      isActive:    false,
      totalEnrolled: 0,
      totalMessagesSent: 0,
      createdAt:   undefined as any,
      updatedAt:   undefined as any,
    }).returning();

    if (messages.length > 0) {
      await db.insert(remarketingMessages).values(
        messages.map((m) => ({ ...m, id: undefined as any, campaignId: newCampaign.id, createdAt: undefined as any, updatedAt: undefined as any }))
      );
    }

    scanSourceAsync("remarketing", newCampaign.id);
    return toCampaignResponse(newCampaign, messages.length);
  },
);

// GET /remarketing/:id/messages
export const listMessages = api(
  { method: "GET", path: "/remarketing/:id/messages", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ messages: MessageResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    await assertCampaignOwnership(id, userId);
    const messages = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, id)).orderBy(remarketingMessages.orderIndex);
    return { messages: messages.map(toMessageResponse) };
  },
);

// PUT /remarketing/:id/messages — replace all messages
export const saveMessages = api(
  { method: "PUT", path: "/remarketing/:id/messages", expose: true, auth: true },
  async ({ id, messages }: { id: string; messages: Array<{ message: string; media?: unknown; inlineButtons?: unknown; offerId?: string | null; delayValue: number; delayUnit: string; orderIndex: number }> }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await assertCampaignOwnership(id, userId);

    await db.delete(remarketingMessages).where(eq(remarketingMessages.campaignId, id));
    if (messages.length > 0) {
      await db.insert(remarketingMessages).values(
        messages.map((m) => ({
          campaignId:    id,
          message:       m.message,
          media:         m.media ?? {},
          inlineButtons: m.inlineButtons ?? [],
          offerId:       m.offerId ?? null,
          delayValue:    m.delayValue,
          delayUnit:     m.delayUnit,
          orderIndex:    m.orderIndex,
        }))
      );
    }
    scanSourceAsync("remarketing", id);
    return { ok: true };
  },
);

// POST /remarketing/:id/enroll — enroll eligible leads into the campaign
export const enroll = api(
  { method: "POST", path: "/remarketing/:id/enroll", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ enrolled: number; total: number }> => {
    const { userID: userId } = getAuthData()!;
    const campaign = await assertCampaignOwnership(id, userId);
    const campaignBotIds = (campaign.botIds as string[]) ?? [campaign.botId];

    // Get all leads for the campaign's bots
    const allLeads = await db.select({ id: leads.id, botId: leads.botId })
      .from(leads)
      .where(inArray(leads.botId, campaignBotIds));

    if (allLeads.length === 0) return { enrolled: 0, total: 0 };

    // Apply filterType
    let eligibleLeads = allLeads;
    if (campaign.filterType === "non_buyers") {
      const buyerIds = await db.select({ leadId: payments.leadId })
        .from(payments)
        .where(and(inArray(payments.botId, campaignBotIds), eq(payments.status, "paid")));
      const buyerSet = new Set(buyerIds.map((r) => r.leadId).filter(Boolean) as string[]);
      eligibleLeads = allLeads.filter((l) => !buyerSet.has(l.id));
    } else if (campaign.filterType === "buyers") {
      const buyerIds = await db.select({ leadId: payments.leadId })
        .from(payments)
        .where(and(inArray(payments.botId, campaignBotIds), eq(payments.status, "paid")));
      const buyerSet = new Set(buyerIds.map((r) => r.leadId).filter(Boolean) as string[]);
      eligibleLeads = allLeads.filter((l) => buyerSet.has(l.id));
    }

    // Exclude already-enrolled leads (active or paused)
    const alreadyEnrolled = await db.select({ leadId: remarketingLeadState.leadId })
      .from(remarketingLeadState)
      .where(and(eq(remarketingLeadState.campaignId, id), inArray(remarketingLeadState.status, ["active", "paused"])));
    const enrolledSet = new Set(alreadyEnrolled.map((r) => r.leadId));
    const toEnroll = eligibleLeads.filter((l) => !enrolledSet.has(l.id));

    if (toEnroll.length > 0) {
      const now = new Date();
      // Upsert: leads nunca inscritos viram um INSERT normal; leads com estado
      // terminal (completed/stopped/blocked/error) já têm uma linha para este
      // (campaign_id, lead_id) e são reinscritos via UPDATE dessa mesma linha,
      // reiniciando a sequência do zero — nunca um segundo INSERT (constraint
      // única em campaign_id+lead_id). A cláusula WHERE é uma trava extra contra
      // a corrida: se a linha virou active/paused entre o SELECT acima e este
      // INSERT, o conflito não atualiza nada (não reinicia um lead em andamento).
      await db.insert(remarketingLeadState).values(
        toEnroll.map((l) => ({
          leadId:     l.id,
          campaignId: id,
          botId:      l.botId,
          status:     "active" as const,
          nextSendAt: now,
        }))
      ).onConflictDoUpdate({
        target: [remarketingLeadState.campaignId, remarketingLeadState.leadId],
        set: {
          botId:             sql`excluded.bot_id`,
          status:            "active",
          nextSendAt:        sql`excluded.next_send_at`,
          nextMessageIndex:  0,
          cyclesCompleted:   0,
          consecutiveErrors: 0,
          updatedAt:         now,
        },
        where: sql`${remarketingLeadState.status} NOT IN ('active', 'paused')`,
      });
    }

    return { enrolled: toEnroll.length, total: eligibleLeads.length };
  },
);
