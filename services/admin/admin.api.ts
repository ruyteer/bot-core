import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { db } from "../shared/database.js";
import {
  profiles, userRoles, bots, funnels, leads, payments, paymentGateways,
  funnelOffers, adminNotifications, adminNotificationRecipients,
  pushSubscriptions, paymentRevenueCredits, platformConfig, paymentWebhookLogs,
} from "../shared/schema/index.js";
import { desc } from "drizzle-orm";
import { sendPushToUser } from "../notifications/application/send-push.use-case.js";
import { eq, and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

// drizzle/node-postgres db.execute() returns QueryResult<T> — extract rows
async function exec<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

// pg returns Date objects for timestamp columns even when typed as string
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  return toIso(v);
}

// Segmento de audiência (mesma lógica em getAudienceCount, no push e no
// audience_size do histórico). `p` é o alias de profiles.
function audiencePredicate(audience: string): SQL {
  switch (audience) {
    case "no_bots":    return sql`NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = p.id)`;
    case "with_bots":  return sql`EXISTS (SELECT 1 FROM bots b WHERE b.user_id = p.id)`;
    case "no_sales":   return sql`NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.user_id = p.id AND pay.status = 'paid')`;
    case "with_sales": return sql`EXISTS (SELECT 1 FROM payments pay WHERE pay.user_id = p.id AND pay.status = 'paid')`;
    default:           return sql`TRUE`;
  }
}
async function audienceCount(audience: string): Promise<number> {
  const [row] = await exec<{ count: number }>(sql`SELECT count(*)::int AS count FROM profiles p WHERE ${audiencePredicate(audience)}`);
  return row?.count ?? 0;
}
async function audienceUserIds(audience: string): Promise<string[]> {
  const rows = await exec<{ id: string }>(sql`SELECT p.id FROM profiles p WHERE ${audiencePredicate(audience)}`);
  return rows.map((r) => r.id);
}

// ─── Admin guard ──────────────────────────────────────────────────────────────

async function requireAdmin(userId: string) {
  const [role] = await db.select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, "admin")))
    .limit(1);
  if (!role) throw APIError.permissionDenied("admin access required");
}

// ─── GET /admin/stats ─────────────────────────────────────────────────────────

export const getStats = api(
  { method: "GET", path: "/admin/stats", expose: true, auth: true },
  async (): Promise<{ total_users: number; total_bots: number; total_leads: number; total_payments: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    const [row] = await exec<{ total_users: number; total_bots: number; total_leads: number; total_payments: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM profiles)                             AS total_users,
        (SELECT count(*)::int FROM bots)                                 AS total_bots,
        (SELECT count(*)::int FROM leads)                                AS total_leads,
        (SELECT count(*)::int FROM payments WHERE status = 'paid')       AS total_payments
    `);

    return {
      total_users:    row.total_users,
      total_bots:     row.total_bots,
      total_leads:    row.total_leads,
      total_payments: row.total_payments,
    };
  },
);

// ─── GET /admin/revenue ───────────────────────────────────────────────────────

interface ProviderRow { provider: string | null; qty: number; gross: number; fees: number }
interface DailyRow    { day: string; gross: number; fees: number; qty: number }

interface RevenueStats {
  total_gross:      number;
  total_fees:       number;
  total_paid_count: number;
  window_days:      number;
  window_gross:     number;
  window_fees:      number;
  window_count:     number;
  pending_count:    number;
  pending_amount:   number;
  by_provider:      ProviderRow[];
  daily:            DailyRow[];
}

export const getRevenue = api(
  { method: "GET", path: "/admin/revenue", expose: true, auth: true },
  async ({ days, since }: { days?: number; since?: string }): Promise<RevenueStats> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    const sinceDate  = since ? new Date(since) : new Date(Date.now() - 86_400_000);
    const windowDays = days ?? 1;

    const [totals] = await exec<{
      total_gross: number; total_fees: number; total_paid_count: number;
      window_gross: number; window_fees: number; window_count: number;
      pending_count: number; pending_amount: number;
    }>(sql`
      SELECT
        coalesce(sum(p.amount) FILTER (WHERE p.status = 'paid'), 0)::float / 100            AS total_gross,
        coalesce((SELECT sum(prc.amount) FROM payment_revenue_credits prc), 0)::float / 100 AS total_fees,
        count(*) FILTER (WHERE p.status = 'paid')::int                                     AS total_paid_count,
        coalesce(sum(p.amount) FILTER (WHERE p.status = 'paid' AND p.created_at >= ${sinceDate}), 0)::float / 100 AS window_gross,
        coalesce((
          SELECT sum(prc2.amount) FROM payment_revenue_credits prc2
          JOIN payments pw ON prc2.payment_id = pw.id
          WHERE pw.status = 'paid' AND pw.created_at >= ${sinceDate}
        ), 0)::float / 100  AS window_fees,
        count(*) FILTER (WHERE p.status = 'paid' AND p.created_at >= ${sinceDate})::int    AS window_count,
        count(*) FILTER (WHERE p.status = 'pending')::int                                  AS pending_count,
        coalesce(sum(p.amount) FILTER (WHERE p.status = 'pending'), 0)::float / 100        AS pending_amount
      FROM payments p
    `);

    const byProvider = await exec<ProviderRow>(sql`
      SELECT
        pg.provider,
        count(p.id)::int            AS qty,
        coalesce(sum(p.amount), 0)::float / 100  AS gross,
        0::float                    AS fees
      FROM payments p
      LEFT JOIN payment_gateways pg ON p.gateway_id = pg.id
      WHERE p.status = 'paid' AND p.created_at >= ${sinceDate}
      GROUP BY pg.provider
      ORDER BY gross DESC
    `);

    const daily = await exec<DailyRow>(sql`
      SELECT
        to_char(date_trunc('day', p.created_at), 'YYYY-MM-DD') AS day,
        coalesce(sum(p.amount), 0)::float / 100  AS gross,
        0::float                                  AS fees,
        count(p.id)::int                          AS qty
      FROM payments p
      WHERE p.status = 'paid' AND p.created_at >= ${sinceDate}
      GROUP BY date_trunc('day', p.created_at)
      ORDER BY date_trunc('day', p.created_at) ASC
    `);

    return {
      total_gross:      totals.total_gross,
      total_fees:       totals.total_fees,
      total_paid_count: totals.total_paid_count,
      window_days:      windowDays,
      window_gross:     totals.window_gross,
      window_fees:      totals.window_fees,
      window_count:     totals.window_count,
      pending_count:    totals.pending_count,
      pending_amount:   totals.pending_amount,
      by_provider:      byProvider,
      daily,
    };
  },
);

// ─── GET /admin/users ─────────────────────────────────────────────────────────

interface AdminUserRow {
  id:            string;
  name:          string | null;
  email:         string | null;
  created_at:    string;
  is_blocked:    boolean;
  is_admin:      boolean;
  bots_count:    number;
  funnels_count: number;
  total_revenue: number;
  paid_count:    number;
  bots: Array<{ id: string; name: string; telegram_username: string | null; is_active: boolean; funnels_count: number }>;
}

export const listUsers = api(
  { method: "GET", path: "/admin/users", expose: true, auth: true },
  async ({ search, page, pageSize }: { search?: string; page?: number; pageSize?: number }): Promise<{ items: AdminUserRow[]; total: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    const limit  = pageSize ?? 25;
    const offset = ((page ?? 1) - 1) * limit;

    const searchCond = search
      ? sql`AND (p.email ILIKE ${"%" + search + "%"} OR p.name ILIKE ${"%" + search + "%"})`
      : sql``;

    type UserRow = {
      id: string; name: string | null; email: string | null; created_at: string;
      is_blocked: boolean; is_admin: boolean; bots_count: number; funnels_count: number;
      total_revenue: number; paid_count: number; total: number;
    };

    const rows = await exec<UserRow>(sql`
      SELECT
        p.id, p.name, p.email, p.created_at, p.is_blocked,
        EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = p.id AND ur.role = 'admin') AS is_admin,
        count(DISTINCT b.id)::int                                                     AS bots_count,
        count(DISTINCT f.id)::int                                                     AS funnels_count,
        coalesce(sum(pay.amount) FILTER (WHERE pay.status = 'paid'), 0)::float / 100 AS total_revenue,
        count(pay.id) FILTER (WHERE pay.status = 'paid')::int                        AS paid_count,
        count(*) OVER ()::int                                                         AS total
      FROM profiles p
      LEFT JOIN bots     b   ON b.user_id   = p.id
      LEFT JOIN funnels  f   ON f.user_id   = p.id
      LEFT JOIN payments pay ON pay.user_id = p.id
      WHERE 1=1 ${searchCond}
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    if (rows.length === 0) return { items: [], total: 0 };

    const total   = rows[0].total;
    const userIds = rows.map((r) => r.id);

    type BotRow = {
      user_id: string; id: string; name: string;
      telegram_username: string | null; is_active: boolean; funnels_count: number;
    };

    const botRows = await exec<BotRow>(sql`
      SELECT
        b.user_id, b.id, b.name, b.telegram_username, b.is_active,
        count(DISTINCT f.id)::int AS funnels_count
      FROM bots b
      LEFT JOIN funnels f ON f.bot_id = b.id
      WHERE b.user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
      GROUP BY b.user_id, b.id
      ORDER BY b.created_at DESC
    `);

    const botsByUser = new Map<string, BotRow[]>();
    for (const bot of botRows) {
      const list = botsByUser.get(bot.user_id) ?? [];
      list.push(bot);
      botsByUser.set(bot.user_id, list);
    }

    const items: AdminUserRow[] = rows.map((r) => ({
      id:            r.id,
      name:          r.name,
      email:         r.email,
      created_at:    toIso(r.created_at as unknown),
      is_blocked:    r.is_blocked,
      is_admin:      r.is_admin,
      bots_count:    r.bots_count,
      funnels_count: r.funnels_count,
      total_revenue: r.total_revenue,
      paid_count:    r.paid_count,
      bots: (botsByUser.get(r.id) ?? []).map((b) => ({
        id:               b.id,
        name:             b.name,
        telegram_username: b.telegram_username,
        is_active:        b.is_active,
        funnels_count:    b.funnels_count,
      })),
    }));

    return { items, total };
  },
);

// ─── GET /admin/users/:id ─────────────────────────────────────────────────────

interface AdminUserDetails {
  profile: { id: string; name: string | null; email: string | null; created_at: string; is_blocked: boolean; is_admin: boolean } | null;
  split_override: { fee_cents: number; updated_at: string } | null;
  metrics: {
    total_revenue: number; total_paid_count: number;
    revenue_30d: number; paid_count_30d: number;
    avg_ticket: number; pending_count_30d: number; pending_amount_30d: number;
    bots_count: number; funnels_count: number; leads_count: number;
  };
  by_provider:    Array<{ provider: string | null; qty: number; gross: number }>;
  daily_revenue:  Array<{ day: string; gross: number; qty: number }>;
  bots:           Array<{ id: string; name: string; telegram_username: string | null; is_active: boolean; funnels_count: number; leads_count: number }>;
  recent_payments: Array<{ id: string; created_at: string; paid_at: string | null; amount: number; status: string; offer_name: string | null; provider: string | null }>;
  // O frontend (AdminUserDetails) lê estes dois — sem eles, `data.gateways.length`
  // dava TypeError e a página de detalhes quebrava no render.
  gateways:        Array<{ id: string; provider: string; label: string; is_active: boolean }>;
  impersonation_log: Array<{ id: string; created_at: string; action: string }>;
}

export const getUserDetails = api(
  { method: "GET", path: "/admin/users/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<AdminUserDetails> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    const [profile] = await db.select().from(profiles).where(eq(profiles.id, id)).limit(1);
    if (!profile) throw APIError.notFound("user not found");

    const [adminRole] = await db.select({ role: userRoles.role }).from(userRoles)
      .where(and(eq(userRoles.userId, id), eq(userRoles.role, "admin"))).limit(1);

    const userGateways = await db.select({
      id: paymentGateways.id, provider: paymentGateways.provider,
      label: paymentGateways.label, isActive: paymentGateways.isActive,
    }).from(paymentGateways).where(eq(paymentGateways.userId, id));

    const splitRow = await db.select({ value: platformConfig.value, updatedAt: platformConfig.updatedAt })
      .from(platformConfig).where(eq(platformConfig.key, `USER_SPLIT_FEE_CENTS_${id}`)).limit(1);

    const split_override = splitRow[0]
      ? { fee_cents: Number(splitRow[0].value), updated_at: splitRow[0].updatedAt.toISOString() }
      : null;

    const ago30 = new Date(Date.now() - 30 * 86_400_000);

    const [metrics] = await exec<{
      total_revenue: number; total_paid_count: number;
      revenue_30d: number; paid_count_30d: number;
      avg_ticket: number; pending_count_30d: number; pending_amount_30d: number;
      bots_count: number; funnels_count: number; leads_count: number;
    }>(sql`
      SELECT
        coalesce(sum(p.amount) FILTER (WHERE p.status = 'paid'), 0)::float / 100           AS total_revenue,
        count(p.id) FILTER (WHERE p.status = 'paid')::int                                  AS total_paid_count,
        coalesce(sum(p.amount) FILTER (WHERE p.status = 'paid' AND p.created_at >= ${ago30}), 0)::float / 100 AS revenue_30d,
        count(p.id) FILTER (WHERE p.status = 'paid' AND p.created_at >= ${ago30})::int    AS paid_count_30d,
        coalesce(avg(p.amount) FILTER (WHERE p.status = 'paid'), 0)::float / 100           AS avg_ticket,
        count(p.id) FILTER (WHERE p.status = 'pending' AND p.created_at >= ${ago30})::int AS pending_count_30d,
        coalesce(sum(p.amount) FILTER (WHERE p.status = 'pending' AND p.created_at >= ${ago30}), 0)::float / 100 AS pending_amount_30d,
        (SELECT count(*)::int FROM bots    WHERE user_id = ${id})   AS bots_count,
        (SELECT count(*)::int FROM funnels WHERE user_id = ${id})   AS funnels_count,
        (SELECT count(*)::int FROM leads l JOIN bots b ON l.bot_id = b.id WHERE b.user_id = ${id}) AS leads_count
      FROM payments p
      WHERE p.user_id = ${id}
    `);

    const byProvider = await exec<{ provider: string; qty: number; gross: number }>(sql`
      SELECT pg.provider, count(p.id)::int AS qty, coalesce(sum(p.amount), 0)::float / 100 AS gross
      FROM payments p
      LEFT JOIN payment_gateways pg ON p.gateway_id = pg.id
      WHERE p.user_id = ${id} AND p.status = 'paid'
      GROUP BY pg.provider ORDER BY gross DESC
    `);

    const dailyRevenue = await exec<{ day: string; gross: number; qty: number }>(sql`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             coalesce(sum(amount), 0)::float / 100 AS gross, count(*)::int AS qty
      FROM payments WHERE user_id = ${id} AND status = 'paid' AND created_at >= ${ago30}
      GROUP BY date_trunc('day', created_at) ORDER BY 1 ASC
    `);

    const userBots = await exec<{ id: string; name: string; telegram_username: string | null; is_active: boolean; funnels_count: number; leads_count: number }>(sql`
      SELECT b.id, b.name, b.telegram_username, b.is_active,
             count(DISTINCT f.id)::int AS funnels_count,
             count(DISTINCT l.id)::int AS leads_count
      FROM bots b
      LEFT JOIN funnels f ON f.bot_id = b.id
      LEFT JOIN leads   l ON l.bot_id = b.id
      WHERE b.user_id = ${id}
      GROUP BY b.id ORDER BY b.created_at DESC
    `);

    const recentPayments = await exec<{ id: string; created_at: unknown; paid_at: unknown; amount: number; status: string; offer_name: string | null; provider: string | null }>(sql`
      SELECT p.id, p.created_at, p.paid_at, p.amount, p.status,
             fo.name AS offer_name, pg.provider
      FROM payments p
      LEFT JOIN funnel_offers    fo ON p.offer_id   = fo.id
      LEFT JOIN payment_gateways pg ON p.gateway_id = pg.id
      WHERE p.user_id = ${id}
      ORDER BY p.created_at DESC LIMIT 20
    `);

    return {
      profile: {
        id:         profile.id,
        name:       profile.name,
        email:      profile.email,
        created_at: profile.createdAt.toISOString(),
        is_blocked: profile.isBlocked,
        is_admin:   !!adminRole,
      },
      split_override,
      metrics:        metrics ?? { total_revenue: 0, total_paid_count: 0, revenue_30d: 0, paid_count_30d: 0, avg_ticket: 0, pending_count_30d: 0, pending_amount_30d: 0, bots_count: 0, funnels_count: 0, leads_count: 0 },
      by_provider:    byProvider,
      daily_revenue:  dailyRevenue.map((r) => ({ day: String(r.day), gross: r.gross, qty: r.qty })),
      bots:           userBots,
      recent_payments: recentPayments.map((r) => ({
        id:         r.id,
        created_at: toIso(r.created_at as unknown),
        paid_at:    toIsoOrNull(r.paid_at as unknown),
        amount:     r.amount / 100,
        status:     r.status,
        offer_name: r.offer_name,
        provider:   r.provider,
      })),
      gateways: userGateways.map((g) => ({ id: g.id, provider: g.provider, label: g.label, is_active: g.isActive })),
      // Impersonation ainda não implementada — array vazio p/ satisfazer a UI.
      impersonation_log: [],
    };
  },
);

// ─── POST /admin/users/:id/block ─────────────────────────────────────────────

export const toggleBlock = api(
  { method: "POST", path: "/admin/users/:id/block", expose: true, auth: true },
  async ({ id, block }: { id: string; block: boolean }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    await db.update(profiles).set({ isBlocked: block, updatedAt: new Date() }).where(eq(profiles.id, id));
    return { ok: true };
  },
);

// ─── DELETE /admin/users/:id ──────────────────────────────────────────────────

export const deleteUser = api(
  { method: "DELETE", path: "/admin/users/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    await db.delete(profiles).where(eq(profiles.id, id));
    return { ok: true };
  },
);

// ─── Gerenciamento de admin (grant/revoke da role) ────────────────────────────
// Antes NÃO existia caminho no código: virar admin só por INSERT manual no banco.

// POST /admin/users/:id/admin — promove o usuário a admin
export const grantAdmin = api(
  { method: "POST", path: "/admin/users/:id/admin", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    const [target] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).limit(1);
    if (!target) throw APIError.notFound("user not found");
    // PK composta (user_id, role) → idempotente.
    await db.insert(userRoles).values({ userId: id, role: "admin" }).onConflictDoNothing();
    return { ok: true };
  },
);

// DELETE /admin/users/:id/admin — remove o admin do usuário
export const revokeAdmin = api(
  { method: "DELETE", path: "/admin/users/:id/admin", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    // Não deixa o último admin se auto-remover (trancaria o painel pra todos).
    if (id === userID) {
      const [{ n }] = await exec<{ n: number }>(sql`SELECT count(*)::int AS n FROM user_roles WHERE role = 'admin'`);
      if (n <= 1) throw APIError.failedPrecondition("não é possível remover o último admin");
    }
    await db.delete(userRoles).where(and(eq(userRoles.userId, id), eq(userRoles.role, "admin")));
    return { ok: true };
  },
);

// ─── GET /admin/webhook-logs ──────────────────────────────────────────────────
// A tela lia payment_webhook_logs direto do Supabase (com realtime), que morreu
// na migração pro Encore. Agora vem por endpoint; o front troca realtime por poll.

interface WebhookLogRow {
  id: string; provider: string | null; external_id: string | null;
  event: string | null; status: string | null; processed: boolean;
  amount: number | null; matched_payment_id: string | null;
  error_message: string | null; source_ip: string | null;
  payload: unknown; created_at: string;
}

export const listWebhookLogs = api(
  { method: "GET", path: "/admin/webhook-logs", expose: true, auth: true },
  async ({ limit }: { limit?: number }): Promise<{ items: WebhookLogRow[] }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    const rows = await db.select().from(paymentWebhookLogs)
      .orderBy(desc(paymentWebhookLogs.createdAt))
      .limit(Math.min(limit ?? 200, 500));
    return {
      items: rows.map((r) => ({
        id: r.id, provider: r.provider, external_id: r.externalId,
        event: r.event, status: r.status, processed: r.processed,
        amount: r.amount == null ? null : r.amount / 100,
        matched_payment_id: r.matchedPaymentId, error_message: r.errorMessage,
        source_ip: r.sourceIp, payload: r.payload,
        created_at: r.createdAt.toISOString(),
      })),
    };
  },
);

// ─── GET /admin/users/:id/split ───────────────────────────────────────────────

export const getUserSplit = api(
  { method: "GET", path: "/admin/users/:id/split", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ fee_cents: number | null }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    const [row] = await db.select({ value: platformConfig.value })
      .from(platformConfig).where(eq(platformConfig.key, `USER_SPLIT_FEE_CENTS_${id}`)).limit(1);
    return { fee_cents: row ? Number(row.value) : null };
  },
);

// ─── PUT /admin/users/:id/split ───────────────────────────────────────────────

export const setUserSplit = api(
  { method: "PUT", path: "/admin/users/:id/split", expose: true, auth: true },
  async ({ id, fee_cents }: { id: string; fee_cents: number | null }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    const key = `USER_SPLIT_FEE_CENTS_${id}`;
    if (fee_cents === null) {
      await db.delete(platformConfig).where(eq(platformConfig.key, key));
    } else {
      await db.insert(platformConfig)
        .values({ key, value: String(fee_cents), updatedBy: userID })
        .onConflictDoUpdate({ target: platformConfig.key, set: { value: String(fee_cents), updatedBy: userID, updatedAt: new Date() } });
    }
    return { ok: true };
  },
);

// ─── GET /admin/payments ──────────────────────────────────────────────────────

interface AdminPaymentRow {
  id:              string;
  created_at:      string;
  paid_at:         string | null;
  updated_at:      string;
  status:          string;
  amount:          number;
  final_amount:    number | null;
  external_id:     string | null;
  description:     string | null;
  bot_id:          string;
  user_id:         string;
  lead_id:         string | null;
  offer_id:        string | null;
  provider:        string | null;
  gateway_label:   string | null;
  bot_name:        string | null;
  bot_username:    string | null;
  user_email:      string | null;
  user_name:       string | null;
  offer_name:      string | null;
  lead_first_name: string | null;
  lead_last_name:  string | null;
  lead_username:   string | null;
  lead_chat_id:    number | null;
}

export const listAdminPayments = api(
  { method: "GET", path: "/admin/payments", expose: true, auth: true },
  async ({
    status, provider, days, since, search, page, pageSize,
  }: {
    status?: string; provider?: string; days?: number; since?: string;
    search?: string; page?: number; pageSize?: number;
  }): Promise<{
    page: number; page_size: number; total: number;
    totals: { paid_count: number; pending_count: number; other_count: number; paid_amount: number; pending_amount: number };
    items: AdminPaymentRow[];
  }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    const limit     = pageSize ?? 25;
    const offset    = ((page ?? 1) - 1) * limit;
    const sinceDate = since ? new Date(since) : null;

    const statusCond   = status   && status   !== "all" ? sql`AND p.status     = ${status}`   : sql``;
    const providerCond = provider && provider !== "all" ? sql`AND pg.provider   = ${provider}` : sql``;
    const sinceCond    = sinceDate                       ? sql`AND p.created_at >= ${sinceDate}` : sql``;
    const searchCond   = search
      ? sql`AND (p.external_id ILIKE ${"%" + search + "%"} OR pr.email ILIKE ${"%" + search + "%"} OR pr.name ILIKE ${"%" + search + "%"} OR b.name ILIKE ${"%" + search + "%"} OR fo.name ILIKE ${"%" + search + "%"})`
      : sql``;

    type RowType = AdminPaymentRow & { total: number; paid_count: number; pending_count: number; other_count: number; paid_sum: number; pending_sum: number };

    const rows = await exec<RowType>(sql`
      SELECT
        p.id, p.created_at, p.paid_at, p.updated_at, p.status,
        p.amount, p.final_amount, p.external_id, p.description,
        p.bot_id, p.user_id, p.lead_id, p.offer_id,
        pg.provider, pg.label AS gateway_label,
        b.name AS bot_name, b.telegram_username AS bot_username,
        pr.email AS user_email, pr.name AS user_name,
        fo.name AS offer_name,
        l.first_name AS lead_first_name, l.last_name AS lead_last_name,
        l.telegram_username AS lead_username,
        l.telegram_chat_id::bigint AS lead_chat_id,
        count(*) OVER ()::int AS total,
        count(*) FILTER (WHERE p.status = 'paid')    OVER ()::int AS paid_count,
        count(*) FILTER (WHERE p.status = 'pending') OVER ()::int AS pending_count,
        count(*) FILTER (WHERE p.status NOT IN ('paid','pending')) OVER ()::int AS other_count,
        coalesce(sum(p.amount) FILTER (WHERE p.status = 'paid')    OVER (), 0)::float / 100 AS paid_sum,
        coalesce(sum(p.amount) FILTER (WHERE p.status = 'pending') OVER (), 0)::float / 100 AS pending_sum
      FROM payments p
      LEFT JOIN payment_gateways pg ON p.gateway_id = pg.id
      LEFT JOIN bots             b  ON p.bot_id     = b.id
      LEFT JOIN profiles         pr ON p.user_id    = pr.id
      LEFT JOIN leads            l  ON p.lead_id    = l.id
      LEFT JOIN funnel_offers    fo ON p.offer_id   = fo.id
      WHERE 1=1 ${statusCond} ${providerCond} ${sinceCond} ${searchCond}
      ORDER BY p.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const first = rows[0];

    return {
      page:      page ?? 1,
      page_size: limit,
      total:     first?.total        ?? 0,
      totals: {
        paid_count:     first?.paid_count    ?? 0,
        pending_count:  first?.pending_count ?? 0,
        other_count:    first?.other_count   ?? 0,
        paid_amount:    first?.paid_sum      ?? 0,
        pending_amount: first?.pending_sum   ?? 0,
      },
      items: rows.map((r) => ({
        id:              r.id,
        created_at:      toIso(r.created_at as unknown),
        paid_at:         toIsoOrNull(r.paid_at as unknown),
        updated_at:      toIso(r.updated_at as unknown),
        status:          r.status,
        amount:          Number(r.amount) / 100,
        final_amount:    r.final_amount != null ? Number(r.final_amount) / 100 : null,
        external_id:     r.external_id,
        description:     r.description,
        bot_id:          r.bot_id,
        user_id:         r.user_id,
        lead_id:         r.lead_id,
        offer_id:        r.offer_id,
        provider:        r.provider,
        gateway_label:   r.gateway_label,
        bot_name:        r.bot_name,
        bot_username:    r.bot_username,
        user_email:      r.user_email,
        user_name:       r.user_name,
        offer_name:      r.offer_name,
        lead_first_name: r.lead_first_name,
        lead_last_name:  r.lead_last_name,
        lead_username:   r.lead_username,
        lead_chat_id:    r.lead_chat_id != null ? Number(r.lead_chat_id) : null,
      })),
    };
  },
);

// ─── GET /admin/config/:key ───────────────────────────────────────────────────

export const getConfig = api(
  { method: "GET", path: "/admin/config/:key", expose: true, auth: true },
  async ({ key }: { key: string }): Promise<{ value: string | null }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    const [row] = await db.select({ value: platformConfig.value })
      .from(platformConfig).where(eq(platformConfig.key, key)).limit(1);
    return { value: row?.value ?? null };
  },
);

// ─── PUT /admin/config/:key ───────────────────────────────────────────────────

export const setConfig = api(
  { method: "PUT", path: "/admin/config/:key", expose: true, auth: true },
  async ({ key, value }: { key: string; value: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    await db.insert(platformConfig)
      .values({ key, value, updatedBy: userID })
      .onConflictDoUpdate({
        target: platformConfig.key,
        set: { value, updatedBy: userID, updatedAt: new Date() },
      });
    return { ok: true };
  },
);

// ─── GET /admin/notifications ─────────────────────────────────────────────────

interface AdminNotif {
  id:            string;
  title:         string;
  body:          string;
  display_mode:  string;
  require_ack:   boolean;
  audience:      string;
  is_active:     boolean;
  created_at:    string;
  audience_size: number;
  seen_count:    number;
  read_count:    number;
  ack_count:     number;
}

export const listNotifications = api(
  { method: "GET", path: "/admin/notifications", expose: true, auth: true },
  async (): Promise<{ notifications: AdminNotif[] }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    const rows = await exec<{
      id: string; title: string; body: string; display_mode: string; require_ack: boolean;
      audience: string; is_active: boolean; created_at: unknown;
      audience_size: number; seen_count: number; read_count: number; ack_count: number;
    }>(sql`
      SELECT
        n.id, n.title, n.body, n.display_mode, n.require_ack, n.audience,
        n.is_active, n.created_at,
        (SELECT count(*)::int FROM profiles p WHERE
          CASE n.audience
            WHEN 'no_bots'    THEN NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = p.id)
            WHEN 'with_bots'  THEN     EXISTS (SELECT 1 FROM bots b WHERE b.user_id = p.id)
            WHEN 'no_sales'   THEN NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.user_id = p.id AND pay.status = 'paid')
            WHEN 'with_sales' THEN     EXISTS (SELECT 1 FROM payments pay WHERE pay.user_id = p.id AND pay.status = 'paid')
            ELSE TRUE
          END
        )                                                                        AS audience_size,
        count(r.user_id)::int                                                    AS seen_count,
        count(r.user_id) FILTER (WHERE r.read_at IS NOT NULL)::int               AS read_count,
        count(r.user_id) FILTER (WHERE r.acknowledged_at IS NOT NULL)::int       AS ack_count
      FROM admin_notifications n
      LEFT JOIN admin_notification_recipients r ON r.notification_id = n.id
      GROUP BY n.id
      ORDER BY n.created_at DESC
    `);

    return {
      notifications: rows.map((r) => ({
        ...r,
        created_at: toIso(r.created_at as unknown),
      })) as AdminNotif[],
    };
  },
);

// ─── POST /admin/notifications ────────────────────────────────────────────────

export const createNotification = api(
  { method: "POST", path: "/admin/notifications", expose: true, auth: true },
  async (req: { title: string; body: string; audience: string; displayMode: string; requireAck: boolean; imageUrl?: string; sendPush?: boolean }): Promise<{ id: string; pushSent: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    const [row] = await db.insert(adminNotifications).values({
      title:       req.title,
      body:        req.body,
      audience:    req.audience,
      displayMode: req.displayMode,
      requireAck:  req.requireAck,
      imageUrl:    req.imageUrl,
      sendPush:    !!req.sendPush,
      createdBy:   userID,
      isActive:    true,
    }).returning({ id: adminNotifications.id });

    // Push real para a audiência (antes o toggle era cosmético). Best-effort:
    // falhas de push não derrubam a criação do comunicado.
    let pushSent = 0;
    if (req.sendPush) {
      try {
        const targets = await audienceUserIds(req.audience);
        const results = await Promise.allSettled(targets.map((uid) => sendPushToUser(uid, {
          eventType: "admin_announcement",
          title:     req.title,
          body:      req.body,
          data:      { notification_id: row.id, image: req.imageUrl, url: "/" },
        })));
        pushSent = results.filter((r) => r.status === "fulfilled" && (r.value as { sent: number }).sent > 0).length;
      } catch (err) {
        console.error("[admin] broadcast push falhou:", err);
      }
    }
    return { id: row.id, pushSent };
  },
);

// ─── PATCH /admin/notifications/:id/archive ───────────────────────────────────

export const archiveNotification = api(
  { method: "PATCH", path: "/admin/notifications/:id/archive", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    await db.update(adminNotifications).set({ isActive: false, updatedAt: new Date() }).where(eq(adminNotifications.id, id));
    return { ok: true };
  },
);

// ─── DELETE /admin/notifications/:id ─────────────────────────────────────────

export const deleteNotification = api(
  { method: "DELETE", path: "/admin/notifications/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    await db.delete(adminNotifications).where(eq(adminNotifications.id, id));
    return { ok: true };
  },
);

// ─── GET /admin/audience/:audience ───────────────────────────────────────────

export const getAudienceCount = api(
  { method: "GET", path: "/admin/audience/:audience", expose: true, auth: true },
  async ({ audience }: { audience: string }): Promise<{ count: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    return { count: await audienceCount(audience) };
  },
);

// ─── GET /admin/push-count ────────────────────────────────────────────────────

export const getPushCount = api(
  { method: "GET", path: "/admin/push-count", expose: true, auth: true },
  async (): Promise<{ total: number; users: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    const [row] = await exec<{ total: number; users: number }>(sql`
      SELECT count(*)::int AS total, count(DISTINCT user_id)::int AS users FROM push_subscriptions
    `);
    return { total: row.total, users: row.users };
  },
);
