import { and, eq, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { paymentReconciliation } from "../../shared/schema/index.js";
import { GatewayDrizzleRepository } from "../infrastructure/gateway.drizzle.repository.js";
import type { PaymentGateway, Provider } from "../domain/gateway.entity.js";
import type { Payment } from "../domain/payment.entity.js";
import type { NormalizedWebhookEvent } from "./gateway-clients.js";
import {
  fetchChargeStatus, GatewayStatusUnavailableError, type GatewayChargeStatus, type UnavailableCode,
} from "./gateway-status.js";

// ── Confirmação de uma cobrança no gateway ──────────────────────────────────
// Ponto único usado pela ENTRADA do webhook (webhooks.ts) e pela conciliação
// (reconcile.ts): dado um pagamento nosso, pergunta ao gateway — com a
// credencial do dono — qual é o status real e devolve um evento normalizado
// montado SÓ com o que o gateway respondeu, pronto pro caso de uso de
// confirmação (processWebhookEvent). Nada do payload do webhook entra no
// status/valor que confirmam a venda.

const gwRepo = new GatewayDrizzleRepository();

// Motivo de a verificação não ter chegado a uma resposta do gateway — vira o
// código `verification_unavailable:<motivo>` no log de webhooks.
export type UnavailableReason =
  | UnavailableCode      // rede, timeout, HTTP de erro, resposta sem status, auth
  | "credentials"        // credencial do gateway ilegível/ausente
  | "gateway_missing";   // gateway do pagamento não existe mais

export type ChargeCheck =
  | { kind: "verified"; charge: GatewayChargeStatus; event: NormalizedWebhookEvent }
  // 404 para todas as chaves tentadas.
  | { kind: "not_found"; lookedUp: string[] }
  // BuckPay: o gateway respondeu uma cobrança, mas de OUTRO id interno — o
  // external_id do payload aponta pra cobrança alheia. Sinal de forja.
  | { kind: "mismatch"; lookedUp: string[] }
  // BuckPay sem nenhuma chave de consulta (PIX criado antes da 0020 e nenhum
  // webhook trouxe o external_id): não dá pra perguntar ao gateway.
  | { kind: "no_lookup_key" }
  | { kind: "unavailable"; reason: UnavailableReason; error: string };

export interface CheckOpts {
  /**
   * Ids extras pra tentar como chave de consulta (candidatos do webhook).
   * Só usados na BuckPay, cuja consulta é pelo external_id que NÓS enviamos —
   * que o webhook traz em data.external_id, mas payments.external_id não.
   */
  extraLookupIds?: string[];
  /** Rótulo do `event` no evento verificado (vai pro log de webhooks). */
  eventLabel?: string;
  gatewayCache?: Map<string, PaymentGateway | null>;
}

/** Chave de consulta guardada na criação do PIX (hoje só BuckPay). */
export async function findGatewayRef(provider: Provider, externalId: string): Promise<string | null> {
  const [row] = await db.select({ gatewayRef: paymentReconciliation.gatewayRef })
    .from(paymentReconciliation)
    .where(and(eq(paymentReconciliation.provider, provider), eq(paymentReconciliation.externalId, externalId)));
  return row?.gatewayRef ?? null;
}

/** Guarda a chave de consulta sem mexer no backoff da conciliação. */
export async function saveGatewayRef(provider: Provider, externalId: string, gatewayRef: string): Promise<void> {
  await db.insert(paymentReconciliation)
    .values({ provider, externalId, gatewayRef })
    .onConflictDoUpdate({
      target: [paymentReconciliation.provider, paymentReconciliation.externalId],
      set:    { gatewayRef: sql`excluded.gateway_ref` },
    });
}

async function loadGateway(id: string, cache?: Map<string, PaymentGateway | null>): Promise<PaymentGateway | null> {
  if (cache?.has(id)) return cache.get(id) ?? null;
  const gw = await gwRepo.findById(id);
  cache?.set(id, gw);
  return gw;
}

export async function checkChargeAtGateway(payment: Payment, opts: CheckOpts = {}): Promise<ChargeCheck> {
  const externalId = payment.externalId;
  if (!externalId) return { kind: "not_found", lookedUp: [] };

  const gw = await loadGateway(payment.gatewayId, opts.gatewayCache);
  if (!gw) return { kind: "unavailable", reason: "gateway_missing", error: `gateway ${payment.gatewayId} não encontrado` };
  const provider = gw.provider;

  let creds: { clientId: string; clientSecret: string };
  try {
    creds = gwRepo.decryptCredentials(gw);
  } catch (err) {
    return { kind: "unavailable", reason: "credentials", error: `credencial do gateway ilegível: ${err instanceof Error ? err.message : String(err)}` };
  }

  // BuckPay: consulta pelo external_id enviado na criação (guardado em
  // payment_reconciliation) e, pra PIX criado antes disso, pelos candidatos do
  // webhook. Como qualquer um pode escrever qualquer coisa no payload, a
  // resposta só vale se o id interno devolvido for o MESMO gravado no nosso
  // pagamento — senão é outra cobrança (ou nenhuma) e o webhook é descartado.
  const storedRef = provider === "buckpay" ? await findGatewayRef(provider, externalId) : null;
  const lookupIds = provider === "buckpay"
    ? [...new Set([storedRef, ...(opts.extraLookupIds ?? [])].filter((v): v is string => !!v && v !== externalId))]
    : [externalId];

  if (lookupIds.length === 0) return { kind: "no_lookup_key" };

  const tried: string[] = [];
  let mismatched = false;
  try {
    for (const lookupId of lookupIds) {
      tried.push(lookupId);
      const charge = await fetchChargeStatus(provider, creds, lookupId);
      if (!charge) continue;
      if (provider === "buckpay" && charge.gatewayTxId !== externalId) { mismatched = true; continue; }
      if (provider === "buckpay" && lookupId !== storedRef) {
        await saveGatewayRef(provider, externalId, lookupId).catch((err) =>
          console.error("[payments] falha ao guardar gateway_ref da BuckPay:", err));
      }
      return {
        kind: "verified",
        charge,
        event: {
          externalId,
          externalIdCandidates: [externalId],
          provider,
          status: charge.status,
          // Valor devolvido pelo gateway. Só o BRUTO é conferido contra o
          // cobrado (checkPaidAmount); líquido (WiinPay) confirma com registro.
          amount:      charge.amount,
          grossAmount: charge.amountIsGross ? charge.amount : null,
          amountIsNet: !charge.amountIsGross && charge.amount !== null,
          event:  opts.eventLabel ?? `gateway:${charge.rawStatus}`,
        },
      };
    }
  } catch (err) {
    if (err instanceof GatewayStatusUnavailableError) return { kind: "unavailable", reason: err.code, error: err.message };
    throw err;
  }
  return mismatched ? { kind: "mismatch", lookedUp: tried } : { kind: "not_found", lookedUp: tried };
}
