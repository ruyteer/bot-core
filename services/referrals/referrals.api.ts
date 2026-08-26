import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../shared/database.js";
import { isUniqueViolation } from "../shared/db-errors.js";
import {
  profiles, userRoles, referralCodes, referrals,
  referralCommissions, referralWithdrawals,
} from "../shared/schema/index.js";
import {
  ensureReferralCode, commissionPercentFor, minWithdrawalCents,
  generateCode, DEFAULT_REFERRAL_PERCENT,
} from "./application/referral-config.js";

async function exec<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

async function requireAdmin(userId: string) {
  const [role] = await db.select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, "admin")))
    .limit(1);
  if (!role) throw APIError.permissionDenied("admin access required");
}

// Saldo disponível = comissões acumuladas − saques pendentes/pagos (rejeitado
// devolve o valor ao saldo).
async function balanceCentsFor(userId: string): Promise<{ earned: number; withdrawnOrPending: number; balance: number }> {
  const [row] = await exec<{ earned: number; withdrawn: number }>(sql`
    SELECT
      coalesce((SELECT sum(amount_cents) FROM referral_commissions WHERE referrer_user_id = ${userId}), 0)::int AS earned,
      coalesce((SELECT sum(amount_cents) FROM referral_withdrawals WHERE user_id = ${userId} AND status IN ('pending','paid')), 0)::int AS withdrawn
  `);
  const earned = row?.earned ?? 0;
  const withdrawnOrPending = row?.withdrawn ?? 0;
  return { earned, withdrawnOrPending, balance: earned - withdrawnOrPending };
}

// ─── Área do usuário ──────────────────────────────────────────────────────────

interface ReferredUserRow {
  name:        string;
  email:       string;   // mascarado
  createdAt:   string;
  earnedCents: number;
}

interface WithdrawalRow {
  id:          string;
  amountCents: number;
  pixKey:      string;
  status:      string;
  notes:       string | null;
  createdAt:   string;
  processedAt: string | null;
}

interface ReferralMeResponse {
  code:                string;
  commissionPercent:   number;
  minWithdrawalCents:  number;
  referredCount:       number;
  totalEarnedCents:    number;
  paidOutCents:        number;
  pendingWithdrawalCents: number;
  balanceCents:        number;
  referred:            ReferredUserRow[];
  withdrawals:         WithdrawalRow[];
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return email;
  const visible = user.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

// GET /referrals/me — código, estatísticas, indicados e saques do usuário.
export const me = api(
  { method: "GET", path: "/referrals/me", expose: true, auth: true },
  async (): Promise<ReferralMeResponse> => {
    const { userID: userId } = getAuthData()!;

    const code    = await ensureReferralCode(userId);
    const percent = await commissionPercentFor(userId);
    const minW    = await minWithdrawalCents();
    const { earned, balance } = await balanceCentsFor(userId);

    const referred = await exec<{ name: string; email: string; created_at: unknown; earned_cents: number }>(sql`
      SELECT p.name, p.email, r.created_at,
             coalesce((SELECT sum(c.amount_cents) FROM referral_commissions c
                       WHERE c.referred_user_id = r.referred_user_id
                         AND c.referrer_user_id = ${userId}), 0)::int AS earned_cents
      FROM referrals r
      JOIN profiles p ON p.id = r.referred_user_id
      WHERE r.referrer_user_id = ${userId}
      ORDER BY r.created_at DESC
    `);

    const withdrawals = await db.select().from(referralWithdrawals)
      .where(eq(referralWithdrawals.userId, userId))
      .orderBy(desc(referralWithdrawals.createdAt));

    const paidOut = withdrawals.filter((w) => w.status === "paid").reduce((s, w) => s + w.amountCents, 0);
    const pending = withdrawals.filter((w) => w.status === "pending").reduce((s, w) => s + w.amountCents, 0);

    return {
      code,
      commissionPercent:      percent,
      minWithdrawalCents:     minW,
      referredCount:          referred.length,
      totalEarnedCents:       earned,
      paidOutCents:           paidOut,
      pendingWithdrawalCents: pending,
      balanceCents:           balance,
      referred: referred.map((r) => ({
        name:        r.name || "Usuário",
        email:       maskEmail(r.email),
        createdAt:   r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        earnedCents: r.earned_cents,
      })),
      withdrawals: withdrawals.map((w) => ({
        id:          w.id,
        amountCents: w.amountCents,
        pixKey:      w.pixKey,
        status:      w.status,
        notes:       w.notes,
        createdAt:   w.createdAt.toISOString(),
        processedAt: w.processedAt?.toISOString() ?? null,
      })),
    };
  },
);

// Janela para vincular a indicação após criar a conta.
const CLAIM_WINDOW_DAYS = 7;

// POST /referrals/claim — vincula quem se cadastrou via link ?ref=CODE.
// Idempotente e "silencioso": responde ok=false com reason em vez de erro,
// porque roda automaticamente no primeiro login (não é ação do usuário).
export const claim = api(
  { method: "POST", path: "/referrals/claim", expose: true, auth: true },
  async ({ code }: { code: string }): Promise<{ ok: boolean; reason?: string }> => {
    const { userID: userId } = getAuthData()!;
    const normalized = (code ?? "").trim().toLowerCase();
    if (!normalized) return { ok: false, reason: "empty_code" };

    const [owner] = await db.select({ userId: referralCodes.userId })
      .from(referralCodes).where(eq(referralCodes.code, normalized)).limit(1);
    if (!owner) return { ok: false, reason: "unknown_code" };
    if (owner.userId === userId) return { ok: false, reason: "self_referral" };

    const [existing] = await db.select({ referrerUserId: referrals.referrerUserId })
      .from(referrals).where(eq(referrals.referredUserId, userId)).limit(1);
    if (existing) return { ok: false, reason: "already_referred" };

    // Só contas novas: evita usuário antigo se vinculando para gerar comissão.
    const [profile] = await db.select({ createdAt: profiles.createdAt })
      .from(profiles).where(eq(profiles.id, userId)).limit(1);
    if (!profile) return { ok: false, reason: "profile_not_found" };
    const ageMs = Date.now() - profile.createdAt.getTime();
    if (ageMs > CLAIM_WINDOW_DAYS * 86_400_000) return { ok: false, reason: "account_too_old" };

    await db.insert(referrals)
      .values({ referredUserId: userId, referrerUserId: owner.userId })
      .onConflictDoNothing();
    return { ok: true };
  },
);

// POST /referrals/withdrawals — solicita saque (pago manualmente pelo admin).
export const requestWithdrawal = api(
  { method: "POST", path: "/referrals/withdrawals", expose: true, auth: true },
  async ({ amountCents, pixKey }: { amountCents: number; pixKey: string }): Promise<{ id: string }> => {
    const { userID: userId } = getAuthData()!;

    const key = (pixKey ?? "").trim();
    if (!key) throw APIError.invalidArgument("informe a chave PIX");
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw APIError.invalidArgument("valor inválido");

    const minW = await minWithdrawalCents();
    if (amountCents < minW) {
      throw APIError.invalidArgument(`o saque mínimo é R$ ${(minW / 100).toFixed(2).replace(".", ",")}`);
    }

    const { balance } = await balanceCentsFor(userId);
    if (amountCents > balance) throw APIError.failedPrecondition("saldo insuficiente");

    // Checagem + insert numa transação: reduz a janela da corrida, mas a barreira
    // AUTORITATIVA é o índice único parcial (referral_withdrawals_pending_user_unique,
    // migration 0015) — duas requisições concorrentes ainda podem passar pelo SELECT
    // antes de qualquer INSERT completar, e é o catch abaixo que fecha essa janela.
    try {
      const row = await db.transaction(async (tx) => {
        const [openRow] = await tx.select({ id: referralWithdrawals.id })
          .from(referralWithdrawals)
          .where(and(eq(referralWithdrawals.userId, userId), eq(referralWithdrawals.status, "pending")))
          .limit(1);
        if (openRow) throw APIError.failedPrecondition("você já tem um saque pendente — aguarde o processamento");

        const [inserted] = await tx.insert(referralWithdrawals)
          .values({ userId, amountCents, pixKey: key })
          .returning({ id: referralWithdrawals.id });
        return inserted;
      });
      return { id: row.id };
    } catch (err) {
      if (isUniqueViolation(err, "referral_withdrawals_pending_user_unique")) {
        throw APIError.failedPrecondition("você já tem um saque pendente — aguarde o processamento");
      }
      throw err;
    }
  },
);

// ─── Admin ────────────────────────────────────────────────────────────────────

interface AdminReferrerRow {
  user_id:           string;
  name:              string | null;
  email:             string | null;
  code:              string;
  commission_percent: number | null;   // null = usa o padrão
  effective_percent: number;
  referred_count:    number;
  earned_cents:      number;
  paid_out_cents:    number;
  pending_cents:     number;
  balance_cents:     number;
}

// GET /admin/referrals — indicadores com código e/ou indicados.
export const adminListReferrers = api(
  { method: "GET", path: "/admin/referrals", expose: true, auth: true },
  async (): Promise<{ items: AdminReferrerRow[]; default_percent: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    const rows = await exec<{
      user_id: string; name: string | null; email: string | null; code: string;
      commission_percent: number | null; referred_count: number;
      earned_cents: number; paid_out_cents: number; pending_cents: number;
    }>(sql`
      SELECT
        rc.user_id, p.name, p.email, rc.code, rc.commission_percent,
        (SELECT count(*)::int FROM referrals r WHERE r.referrer_user_id = rc.user_id)                                     AS referred_count,
        coalesce((SELECT sum(c.amount_cents) FROM referral_commissions c WHERE c.referrer_user_id = rc.user_id), 0)::int  AS earned_cents,
        coalesce((SELECT sum(w.amount_cents) FROM referral_withdrawals w WHERE w.user_id = rc.user_id AND w.status = 'paid'), 0)::int    AS paid_out_cents,
        coalesce((SELECT sum(w.amount_cents) FROM referral_withdrawals w WHERE w.user_id = rc.user_id AND w.status = 'pending'), 0)::int AS pending_cents
      FROM referral_codes rc
      JOIN profiles p ON p.id = rc.user_id
      ORDER BY earned_cents DESC, referred_count DESC
    `);

    const [cfg] = await exec<{ value: string }>(sql`SELECT value FROM platform_config WHERE key = 'REFERRAL_COMMISSION_PERCENT'`);
    const defaultPercent = cfg && Number.isFinite(Number(cfg.value)) && Number(cfg.value) > 0
      ? Number(cfg.value) : DEFAULT_REFERRAL_PERCENT;

    return {
      default_percent: defaultPercent,
      items: rows.map((r) => ({
        user_id:            r.user_id,
        name:               r.name,
        email:              r.email,
        code:               r.code,
        commission_percent: r.commission_percent,
        effective_percent:  r.commission_percent ?? defaultPercent,
        referred_count:     r.referred_count,
        earned_cents:       r.earned_cents,
        paid_out_cents:     r.paid_out_cents,
        pending_cents:      r.pending_cents,
        balance_cents:      r.earned_cents - r.paid_out_cents - r.pending_cents,
      })),
    };
  },
);

// PUT /admin/referrals/:userId/commission — a "opção de aumentar comissão de
// sellers específicos". percent=null volta ao padrão da plataforma. Cria o
// código do usuário se ainda não existir (admin pode configurar antes do
// seller abrir a página).
export const adminSetCommission = api(
  { method: "PUT", path: "/admin/referrals/:userId/commission", expose: true, auth: true },
  async ({ userId, percent }: { userId: string; percent: number | null }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    if (percent !== null && (!Number.isInteger(percent) || percent < 0 || percent > 100)) {
      throw APIError.invalidArgument("percentual deve ser um inteiro entre 0 e 100");
    }

    const [target] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, userId)).limit(1);
    if (!target) throw APIError.notFound("user not found");

    await db.insert(referralCodes)
      .values({ userId, code: generateCode(), commissionPercent: percent })
      .onConflictDoUpdate({
        target: referralCodes.userId,
        set:    { commissionPercent: percent, updatedAt: new Date() },
      });
    return { ok: true };
  },
);

interface AdminWithdrawalRow {
  id:           string;
  user_id:      string;
  name:         string | null;
  email:        string | null;
  amount_cents: number;
  pix_key:      string;
  status:       string;
  notes:        string | null;
  created_at:   string;
  processed_at: string | null;
}

// GET /admin/referrals/withdrawals — fila de saques (manual por enquanto).
export const adminListWithdrawals = api(
  { method: "GET", path: "/admin/referrals/withdrawals", expose: true, auth: true },
  async ({ status }: { status?: string }): Promise<{ items: AdminWithdrawalRow[] }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    const statusCond = status && status !== "all" ? sql`AND w.status = ${status}` : sql``;
    const rows = await exec<{
      id: string; user_id: string; name: string | null; email: string | null;
      amount_cents: number; pix_key: string; status: string; notes: string | null;
      created_at: unknown; processed_at: unknown;
    }>(sql`
      SELECT w.id, w.user_id, p.name, p.email, w.amount_cents, w.pix_key,
             w.status, w.notes, w.created_at, w.processed_at
      FROM referral_withdrawals w
      JOIN profiles p ON p.id = w.user_id
      WHERE 1=1 ${statusCond}
      ORDER BY (w.status = 'pending') DESC, w.created_at DESC
      LIMIT 200
    `);

    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
    return {
      items: rows.map((r) => ({
        id:           r.id,
        user_id:      r.user_id,
        name:         r.name,
        email:        r.email,
        amount_cents: r.amount_cents,
        pix_key:      r.pix_key,
        status:       r.status,
        notes:        r.notes,
        created_at:   iso(r.created_at)!,
        processed_at: iso(r.processed_at),
      })),
    };
  },
);

// POST /admin/referrals/withdrawals/:id/process — marca pago (transferência
// manual feita) ou rejeita (valor volta ao saldo do indicador).
export const adminProcessWithdrawal = api(
  { method: "POST", path: "/admin/referrals/withdrawals/:id/process", expose: true, auth: true },
  async ({ id, action, notes }: { id: string; action: "paid" | "rejected"; notes?: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);

    if (action !== "paid" && action !== "rejected") throw APIError.invalidArgument("action inválida");

    const [row] = await db.select().from(referralWithdrawals).where(eq(referralWithdrawals.id, id)).limit(1);
    if (!row) throw APIError.notFound("saque não encontrado");
    if (row.status !== "pending") throw APIError.failedPrecondition("saque já processado");

    if (action === "paid") {
      // Recheck bruta de saldo antes de marcar pago: NÃO usar balanceCentsFor
      // aqui — ela já desconta pending+paid, o que incluiria ESTE saque (ainda
      // pending) como já descontado e a checagem sempre falharia. A conta certa
      // é bruta: quanto já foi EFETIVAMENTE pago (status='paid', ignora outros
      // pending) precisa deixar espaço pra cobrir este saque dentro do total ganho.
      const [sums] = await exec<{ earned: number; paid: number }>(sql`
        SELECT
          coalesce((SELECT sum(amount_cents) FROM referral_commissions WHERE referrer_user_id = ${row.userId}), 0)::int AS earned,
          coalesce((SELECT sum(amount_cents) FROM referral_withdrawals WHERE user_id = ${row.userId} AND status = 'paid'), 0)::int AS paid
      `);
      const earned = sums?.earned ?? 0;
      const alreadyPaid = sums?.paid ?? 0;
      if (earned - alreadyPaid < row.amountCents) {
        throw APIError.failedPrecondition("saldo do indicador não cobre mais este saque");
      }
    }

    // WHERE status='pending' explícito + confere linhas afetadas: se vier 0,
    // outra aprovação concorrente já processou este mesmo saque entre o SELECT
    // acima e este UPDATE.
    const updated = await db.update(referralWithdrawals).set({
      status:      action,
      notes:       notes?.trim() || null,
      processedBy: userID,
      processedAt: new Date(),
    }).where(and(eq(referralWithdrawals.id, id), eq(referralWithdrawals.status, "pending")))
      .returning({ id: referralWithdrawals.id });
    if (updated.length === 0) throw APIError.failedPrecondition("saque já processado");

    return { ok: true };
  },
);
