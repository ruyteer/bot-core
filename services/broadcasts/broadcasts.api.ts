import { api, APIError } from "encore.dev/api";
import { scanSourceAsync } from "../compliance/application/scan.js";
import { getAuthData } from "~encore/auth";
import { db } from "../shared/database.js";
import { scheduledMessages, bots, broadcastRuns } from "../shared/schema/index.js";
import { eq, and, inArray, desc, gte, sql } from "drizzle-orm";
import { DEFAULT_TZ, zonedWallTimeToUtc } from "./application/process-broadcasts.use-case.js";
import { sanitizeButtonArray } from "../runner/application/telegram-button-style.js";

// ─── Ingestão de datas ────────────────────────────────────────────────────────
// Strings ISO-8601 COM offset/Z são um instante inequívoco e podem ser parseadas
// diretamente. Strings SEM offset (ex.: "2026-08-12T15:00", vindas de um
// <input type="datetime-local">) são ambíguas: `new Date(...)` as interpretaria no
// fuso horário do PROCESSO NODE (em produção, UTC no Railway), não no fuso do usuário —
// causando disparos até 3h adiantados/atrasados. Por isso, entrada sem offset é
// interpretada explicitamente no fuso do broadcast (tz da recurrenceRule, ou
// DEFAULT_TZ = America/Sao_Paulo), usando o mesmo helper tz-aware da recorrência.
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

function extractTz(recurrenceRule: unknown): string {
  const rule = recurrenceRule as { tz?: string } | null | undefined;
  return (rule && typeof rule.tz === "string" && rule.tz) || DEFAULT_TZ;
}

function parseScheduledAt(input: string, tz: string = DEFAULT_TZ): Date {
  if (HAS_OFFSET.test(input)) return new Date(input);
  const [datePart, timePart = "00:00"] = input.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, s] = timePart.split(":").map((n) => Number(n) || 0);
  return zonedWallTimeToUtc(y, (mo || 1) - 1, d, h, mi, tz, s || 0);
}

// ─── Response shapes ─────────────────────────────────────────────────────────

interface ScheduledMessageResponse {
  id:                       string;
  botId:                    string;
  botIds:                   string[];
  message:                  string;
  broadcastType:            string;
  filterType:               string;
  targetType:               string;
  targetGroupIds:           string[];
  funnelId:                 string | null;
  advancedFilters:          unknown | null;
  scheduledAt:              string;
  sentAt:                   string | null;
  status:                   string;
  recurrenceRule:           unknown | null;
  recurrenceCount:          number;
  recurrenceMaxOccurrences: number | null;
  recurrenceEndAt:          string | null;
  createdAt:                string;
}

interface BroadcastRunResponse {
  id:           string;
  botId:        string;
  status:       string;
  totalTargets: number;
  sentCount:    number;
  failedCount:  number;
  startedAt:    string;
  finishedAt:   string | null;
}

function toScheduledResponse(r: typeof scheduledMessages.$inferSelect): ScheduledMessageResponse {
  return {
    id:                       r.id,
    botId:                    r.botId,
    botIds:                   (r.botIds as string[]) ?? [],
    message:                  r.message,
    broadcastType:            r.broadcastType,
    filterType:               r.filterType,
    targetType:               r.targetType,
    targetGroupIds:           (r.targetGroupIds as string[]) ?? [],
    funnelId:                 r.funnelId,
    advancedFilters:          r.advancedFilters ?? null,
    scheduledAt:              r.scheduledAt.toISOString(),
    sentAt:                   r.sentAt?.toISOString() ?? null,
    status:                   r.status,
    recurrenceRule:           r.recurrenceRule,
    recurrenceCount:          r.recurrenceCount,
    recurrenceMaxOccurrences: r.recurrenceMaxOccurrences ?? null,
    recurrenceEndAt:          r.recurrenceEndAt?.toISOString() ?? null,
    createdAt:                r.createdAt.toISOString(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// advancedFilters é JSON arbitrário vindo do cliente (create/update), mas quando
// carrega inline_buttons/offers (é o que sendBroadcast/buildKeyboard leem em
// process-broadcasts.use-case.ts) o `style` de cada botão passa pela mesma whitelist.
function sanitizeAdvancedFilters(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const obj = { ...(input as Record<string, unknown>) };
  if ("inline_buttons" in obj) obj.inline_buttons = sanitizeButtonArray(obj.inline_buttons);
  if ("offers" in obj) obj.offers = sanitizeButtonArray(obj.offers);
  return obj;
}

async function getUserBotIds(userId: string): Promise<string[]> {
  const rows = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
  return rows.map((b) => b.id);
}

async function assertBotOwnership(botId: string, userId: string): Promise<void> {
  const row = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, botId), eq(bots.userId, userId))).limit(1);
  if (!row.length) throw APIError.notFound("bot not found");
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// GET /broadcasts?botId=...&status=...
export const list = api(
  { method: "GET", path: "/broadcasts", expose: true, auth: true },
  async ({ botId, status }: { botId?: string; status?: string }): Promise<{ messages: ScheduledMessageResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    if (botId) await assertBotOwnership(botId, userId);
    const botIds = botId ? [botId] : await getUserBotIds(userId);
    if (botIds.length === 0) return { messages: [] };

    let q = db.select().from(scheduledMessages).where(inArray(scheduledMessages.botId, botIds)).$dynamic();
    if (status) q = q.where(eq(scheduledMessages.status, status));
    const rows = await q.orderBy(desc(scheduledMessages.scheduledAt)).limit(200);
    return { messages: rows.map(toScheduledResponse) };
  },
);

// GET /broadcasts/stats?botId=...
export const broadcastStats = api(
  { method: "GET", path: "/broadcasts/stats", expose: true, auth: true },
  async ({ botId, start }: { botId?: string; start?: string }): Promise<{ pending: number; sent: number; running: number }> => {
    const { userID: userId } = getAuthData()!;
    if (botId) await assertBotOwnership(botId, userId);
    const botIds = botId ? [botId] : await getUserBotIds(userId);
    if (botIds.length === 0) return { pending: 0, sent: 0, running: 0 };

    const since = start ? new Date(start) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const rows = await db.select({ status: scheduledMessages.status, count: sql<number>`count(*)::int` })
      .from(scheduledMessages)
      .where(and(inArray(scheduledMessages.botId, botIds), gte(scheduledMessages.scheduledAt, since)))
      .groupBy(scheduledMessages.status);

    const m: Record<string, number> = {};
    rows.forEach((r) => { m[r.status] = r.count; });
    return { pending: m["pending"] ?? 0, sent: m["sent"] ?? 0, running: m["running"] ?? 0 };
  },
);

// GET /broadcasts/:id
export const getById = api(
  { method: "GET", path: "/broadcasts/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<ScheduledMessageResponse> => {
    const { userID: userId } = getAuthData()!;
    const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)).limit(1);
    if (!rows.length) throw APIError.notFound("broadcast not found");
    await assertBotOwnership(rows[0].botId, userId);
    return toScheduledResponse(rows[0]);
  },
);

// POST /broadcasts
export const create = api(
  { method: "POST", path: "/broadcasts", expose: true, auth: true },
  async (req: {
    botId: string;
    botIds?: string[];
    message: string;
    broadcastType?: string;
    filterType?: string;
    advancedFilters?: unknown | null;
    targetType?: string;
    targetGroupIds?: string[];
    funnelId?: string | null;
    scheduledAt: string;
    recurrenceRule?: unknown | null;
    recurrenceMaxOccurrences?: number | null;
    recurrenceEndAt?: string | null;
  }): Promise<ScheduledMessageResponse> => {
    const { userID: userId } = getAuthData()!;
    const userBotIdSet = new Set(await getUserBotIds(userId));
    if (!userBotIdSet.has(req.botId)) throw APIError.notFound("bot not found");
    const allBotIds = req.botIds ?? [req.botId];
    if (!allBotIds.every((id) => userBotIdSet.has(id))) throw APIError.permissionDenied("bot not owned");

    const tz = extractTz(req.recurrenceRule);
    const [row] = await db.insert(scheduledMessages).values({
      userId,
      botId:                    req.botId,
      botIds:                   allBotIds,
      message:                  req.message,
      broadcastType:            req.broadcastType ?? "instant",
      filterType:               req.filterType ?? "all",
      advancedFilters:          sanitizeAdvancedFilters(req.advancedFilters ?? null),
      targetType:               req.targetType ?? "leads",
      targetGroupIds:           req.targetGroupIds ?? [],
      funnelId:                 req.funnelId ?? null,
      scheduledAt:              parseScheduledAt(req.scheduledAt, tz),
      status:                   "pending",
      recurrenceRule:           req.recurrenceRule ?? null,
      recurrenceCount:          0,
      recurrenceMaxOccurrences: req.recurrenceMaxOccurrences ?? null,
      recurrenceEndAt:          req.recurrenceEndAt ? parseScheduledAt(req.recurrenceEndAt, tz) : null,
    }).returning();

    scanSourceAsync("broadcast", row.id);
    return toScheduledResponse(row);
  },
);

// POST /broadcasts/send — queue an immediate broadcast
export const send = api(
  { method: "POST", path: "/broadcasts/send", expose: true, auth: true },
  async (req: {
    botIds: string[];
    broadcastType: string;
    filterType: string;
    filterProductId?: string | null;
    targetType: string;
    targetGroupIds: string[];
    funnelId?: string | null;
    message?: string;
    inlineButtons?: unknown[];
    offers?: unknown[];
    media?: unknown[];
  }): Promise<{ accepted: boolean }> => {
    const { userID: userId } = getAuthData()!;
    if (!req.botIds.length) throw APIError.invalidArgument("botIds must not be empty");
    const userBotIdSet = new Set(await getUserBotIds(userId));
    if (!req.botIds.every((id) => userBotIdSet.has(id))) throw APIError.permissionDenied("bot not owned");

    await db.insert(scheduledMessages).values({
      userId,
      botId:           req.botIds[0],
      botIds:          req.botIds,
      message:         req.message ?? "",
      broadcastType:   req.broadcastType,
      filterType:      req.filterType,
      advancedFilters: {
        filter_product_id: req.filterProductId ?? null,
        inline_buttons:    sanitizeButtonArray(req.inlineButtons ?? []),
        offers:            sanitizeButtonArray(req.offers ?? []),
        media:             req.media ?? [],
      },
      targetType:      req.targetType,
      targetGroupIds:  req.targetGroupIds ?? [],
      funnelId:        req.funnelId ?? null,
      scheduledAt:     new Date(),
      status:          "pending",
      recurrenceRule:  null,
      recurrenceCount: 0,
    });

    return { accepted: true };
  },
);

// PATCH /broadcasts/:id
export const update = api(
  { method: "PATCH", path: "/broadcasts/:id", expose: true, auth: true },
  async ({ id, ...req }: {
    id: string;
    message?: string;
    filterType?: string;
    advancedFilters?: unknown | null;
    targetType?: string;
    targetGroupIds?: string[];
    scheduledAt?: string;
    recurrenceRule?: unknown | null;
    recurrenceMaxOccurrences?: number | null;
    recurrenceEndAt?: string | null;
    recurrenceCount?: number;
  }): Promise<ScheduledMessageResponse> => {
    const { userID: userId } = getAuthData()!;
    const existing = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)).limit(1);
    if (!existing.length) throw APIError.notFound("broadcast not found");
    await assertBotOwnership(existing[0].botId, userId);

    // tz efetivo: usa a recurrenceRule enviada no patch (se houver), senão a já persistida —
    // garante que scheduledAt/recurrenceEndAt sejam interpretados no mesmo fuso da recorrência.
    const tz = extractTz("recurrenceRule" in req ? req.recurrenceRule : existing[0].recurrenceRule);

    const patch: Partial<typeof scheduledMessages.$inferInsert> = { updatedAt: new Date() };
    if (req.message !== undefined)                patch.message = req.message;
    if (req.filterType !== undefined)             patch.filterType = req.filterType;
    if ("advancedFilters" in req)                 patch.advancedFilters = sanitizeAdvancedFilters(req.advancedFilters);
    if (req.targetType !== undefined)             patch.targetType = req.targetType;
    if (req.targetGroupIds !== undefined)         patch.targetGroupIds = req.targetGroupIds;
    if (req.scheduledAt !== undefined)            patch.scheduledAt = parseScheduledAt(req.scheduledAt, tz);
    if ("recurrenceRule" in req)                  patch.recurrenceRule = req.recurrenceRule;
    if ("recurrenceMaxOccurrences" in req)        patch.recurrenceMaxOccurrences = req.recurrenceMaxOccurrences;
    if (req.recurrenceEndAt !== undefined)        patch.recurrenceEndAt = req.recurrenceEndAt ? parseScheduledAt(req.recurrenceEndAt, tz) : null;
    if (req.recurrenceCount !== undefined)        patch.recurrenceCount = req.recurrenceCount;

    const [updated] = await db.update(scheduledMessages).set(patch).where(eq(scheduledMessages.id, id)).returning();
    scanSourceAsync("broadcast", id);
    return toScheduledResponse(updated);
  },
);

// DELETE /broadcasts/:id
export const remove = api(
  { method: "DELETE", path: "/broadcasts/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<void> => {
    const { userID: userId } = getAuthData()!;
    const existing = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)).limit(1);
    if (!existing.length) throw APIError.notFound("broadcast not found");
    await assertBotOwnership(existing[0].botId, userId);
    await db.delete(scheduledMessages).where(eq(scheduledMessages.id, id));
  },
);

// GET /broadcasts/runs?botId=...
export const listRuns = api(
  { method: "GET", path: "/broadcasts/runs", expose: true, auth: true },
  async ({ botId }: { botId?: string }): Promise<{ runs: BroadcastRunResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    if (botId) await assertBotOwnership(botId, userId);
    const botIds = botId ? [botId] : await getUserBotIds(userId);
    if (botIds.length === 0) return { runs: [] };

    const rows = await db.select().from(broadcastRuns)
      .where(inArray(broadcastRuns.botId, botIds))
      .orderBy(desc(broadcastRuns.startedAt))
      .limit(100);

    return {
      runs: rows.map((r) => ({
        id:           r.id,
        botId:        r.botId,
        status:       r.status,
        totalTargets: r.totalTargets,
        sentCount:    r.sentCount,
        failedCount:  r.failedCount,
        startedAt:    r.startedAt.toISOString(),
        finishedAt:   r.finishedAt?.toISOString() ?? null,
      })),
    };
  },
);
