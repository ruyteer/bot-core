import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";
import { db } from "../shared/database.js";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { checkChargeAtGateway } from "./application/verify-with-gateway.js";
import { processWebhookEvent } from "./webhooks.js";
import { canTransition, type PaymentStatus } from "./domain/payment-status.js";
import { isPlatformAdmin } from "../shared/roles.js";
import type { PaymentGateway } from "./domain/gateway.entity.js";

// ── Conciliação de pagamentos pendentes com o gateway ───────────────────────
// Não existia nenhuma: se o webhook se perdesse (gateway fora, deploy no meio,
// cadastro de webhook ausente na conta SyncPay, 5xx nosso), a venda ficava
// pendente pra sempre com o cliente tendo pago. Aqui, periodicamente, os
// pagamentos pendentes recentes são consultados no gateway e o status real é
// aplicado pelo MESMO caminho do webhook: checkChargeAtGateway monta o evento
// só com a resposta do gateway e processWebhookEvent (caso de uso de
// confirmação) aplica, com a mesma chave de idempotência do webhook.
//
// Backoff por cobrança (payment_reconciliation.last_checked_at): o intervalo
// entre consultas cresce com a idade do PIX — max(2min, idade/4). Um PIX de
// 10min é conferido a cada ~2,5min; um de 12h, a cada 3h. Sem isso, todo PIX
// gerado e nunca pago (a maioria) viraria uma consulta por minuto por 24h.

const PAYMENT_MIN_AGE_MS = 2 * 60_000;           // dá tempo do webhook chegar primeiro
const RECONCILE_WINDOW_MS = 24 * 60 * 60_000;    // PIX mais velho que isso não é mais conferido
const RECONCILE_BATCH = 25;                      // consultas por tick (cada uma é 1–2 requests)

const payRepo = new PaymentDrizzleRepository();

interface DueRow {
  id:           string;
  provider:     string;
  external_id:  string;
  last_checked: string | null;
}

// Marca a cobrança como conferida AGORA — só se ninguém conferiu desde que a
// lemos (compare-and-set em last_checked_at). Dois ticks sobrepostos (ou dois
// processos) nunca consultam a mesma cobrança ao mesmo tempo.
async function claim(row: DueRow, now: Date): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO payment_reconciliation (provider, external_id, last_checked_at, check_count)
    VALUES (${row.provider}, ${row.external_id}, ${now.toISOString()}::timestamptz, 1)
    ON CONFLICT (provider, external_id) DO UPDATE
      SET last_checked_at = excluded.last_checked_at,
          check_count     = payment_reconciliation.check_count + 1
      WHERE payment_reconciliation.last_checked_at IS NOT DISTINCT FROM ${row.last_checked}::timestamptz
    RETURNING provider`);
  return (res.rows ?? []).length > 0;
}

export interface ReconcileResult {
  checked:     number;
  applied:     number;
  unavailable: number;
  /** BuckPay sem chave de consulta (PIX anterior à 0020 sem webhook que a trouxesse). */
  noLookupKey: number;
}

export async function reconcilePendingPayments(now: Date = new Date()): Promise<ReconcileResult> {
  const nowIso      = now.toISOString();
  const oldestIso   = new Date(now.getTime() - RECONCILE_WINDOW_MS).toISOString();
  const youngestIso = new Date(now.getTime() - PAYMENT_MIN_AGE_MS).toISOString();

  const due = await db.execute(sql`
    SELECT p.id, g.provider, p.external_id, r.last_checked_at::text AS last_checked
    FROM payments p
    JOIN payment_gateways g ON g.id = p.gateway_id
    LEFT JOIN payment_reconciliation r ON r.provider = g.provider AND r.external_id = p.external_id
    -- expired também: o runner expira LOCALMENTE (re-clique após o
    -- unpaid_timeout) um PIX que continua pagável no gateway, e a máquina de
    -- estados aceita expired → paid justamente por isso.
    WHERE p.status IN ('pending', 'expired')
      AND p.external_id IS NOT NULL
      AND p.created_at >= ${oldestIso}::timestamptz
      AND p.created_at <= ${youngestIso}::timestamptz
      AND (
        r.last_checked_at IS NULL
        OR r.last_checked_at <= ${nowIso}::timestamptz
             - GREATEST(interval '2 minutes', (${nowIso}::timestamptz - p.created_at) / 4)
      )
    ORDER BY r.last_checked_at ASC NULLS FIRST, p.created_at ASC
    LIMIT ${RECONCILE_BATCH}`);

  const result: ReconcileResult = { checked: 0, applied: 0, unavailable: 0, noLookupKey: 0 };
  const gatewayCache = new Map<string, PaymentGateway | null>();

  for (const row of (due.rows ?? []) as unknown as DueRow[]) {
    try {
      if (!(await claim(row, now))) continue;
      const payment = await payRepo.findById(row.id);
      if (!payment || (payment.status !== "pending" && payment.status !== "expired")) continue;

      result.checked++;
      const check = await checkChargeAtGateway(payment, { eventLabel: "reconciliation", gatewayCache });
      if (check.kind === "unavailable") {
        result.unavailable++;
        console.warn(`[payments] conciliação: não deu pra consultar ${row.provider} ${row.external_id}: ${check.error}`);
        continue;
      }
      if (check.kind === "no_lookup_key") {
        result.noLookupKey++;
        console.warn(`[payments] conciliação: BuckPay ${row.external_id} sem chave de consulta (PIX anterior à 0020) — só o webhook confirma esta cobrança`);
        continue;
      }
      if (check.kind === "not_found" || check.kind === "mismatch") {
        console.warn(`[payments] conciliação: cobrança ${row.provider} ${row.external_id} ${check.kind === "mismatch" ? "devolvida com outro id interno" : "não encontrada"} no gateway (consultado: [${check.lookedUp.join(", ")}])`);
        continue;
      }
      // Só aplica o que a máquina de estados aceita a partir do status atual —
      // ex.: um PIX já expirado localmente que o gateway também diz expirado
      // não vira log de "transição inválida" a cada conferência.
      if (!canTransition(payment.status, check.charge.status as PaymentStatus)) continue;

      await processWebhookEvent(check.event, {
        source:  "reconciliation",
        gateway: check.charge.raw,
      });
      result.applied++;
    } catch (err) {
      console.error(`[payments] conciliação falhou para ${row.provider} ${row.external_id}:`, err);
    }
  }
  return result;
}

// Disparo manual (diagnóstico). Além de privado (expose: false), exige usuário
// autenticado e admin da plataforma — não depende só do roteamento. Mesmo se
// chamado, não aceita entrada e respeita o claim/backoff acima: no pior caso
// adianta um tick, nunca aplica status que o gateway não confirmou.
export const reconcilePayments = api(
  { method: "POST", path: "/payments/reconcile", expose: false, auth: true },
  async (): Promise<ReconcileResult> => {
    const { userID } = getAuthData()!;
    if (!(await isPlatformAdmin(userID))) throw APIError.permissionDenied("admin access required");
    return reconcilePendingPayments();
  },
);

// ── Scheduler interno ─────────────────────────────────────────────────────────
// Cron do Encore não dispara em self-hosted (Railway) — mesmo motivo do
// setInterval do runner (runner.ts). Guarda por TEMPO: um tick travado (rede)
// não congela a conciliação pra sempre; o claim acima impede consulta dupla.
const RECONCILE_TICK_MS     = 60_000;
const RECONCILE_TICK_MAX_MS = 5 * 60_000;

let runningSince = 0;
async function tick(): Promise<void> {
  const now = Date.now();
  if (runningSince && now - runningSince < RECONCILE_TICK_MAX_MS) return;
  runningSince = now;
  try {
    const r = await reconcilePendingPayments();
    if (r.applied > 0 || r.unavailable > 0 || r.noLookupKey > 0) {
      console.log(`[payments] conciliação: ${r.checked} conferido(s), ${r.applied} aplicado(s), ${r.unavailable} sem resposta do gateway, ${r.noLookupKey} BuckPay sem chave de consulta`);
    }
  } catch (err) {
    console.error("[payments] tick de conciliação falhou:", err);
  } finally {
    runningSince = 0;
  }
}

setInterval(() => { void tick(); }, RECONCILE_TICK_MS);
