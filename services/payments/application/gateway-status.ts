import type { Provider } from "../domain/gateway.entity.js";
import { SYNCPAY_PAID_STATUSES, NEXUSPAG_PAID_STATUSES } from "./gateway-clients.js";

// ── Consulta ativa do status de uma cobrança no gateway ─────────────────────
// Nenhum dos 4 gateways assina o webhook de um jeito que dê pra validar com o
// cadastro que temos hoje (SyncPay manda um Bearer que só é devolvido no
// cadastro do webhook e nunca foi guardado; NexusPag tem HMAC com segredo
// configurado no painel dela, fora do nosso cadastro; BuckPay e WiinPay não
// assinam). Então o payload do webhook NÃO é fonte da verdade: ele só diz
// "olhe esta cobrança", e o status/valor que valem são os que a API do gateway
// devolve, consultada com a credencial do próprio dono do gateway. É o mesmo
// caminho usado pela conciliação periódica (reconcile.ts).
//
// Endpoints (mesmos do check-payments do sistema antigo, que rodou em produção):
// - SyncPay:  GET  /api/partner/v1/transaction/{identifier}  (Bearer do auth-token)
// - BuckPay:  GET  /v1/transactions/external_id/{external_id} (Bearer + User-Agent)
// - NexusPag: GET  /api/pix/{id}                              (x-api-key)
// - WiinPay:  GET  /payment/list/{paymentId}                  (Bearer api_key)

export type ChargeStatus = "paid" | "pending" | "cancelled" | "expired";

export interface GatewayChargeStatus {
  status:    ChargeStatus;
  /** Valor da cobrança em centavos, quando o gateway informa. */
  amount:    number | null;
  /**
   * true = `amount` é o valor BRUTO (o que o comprador pagou) e pode ser
   * conferido contra o cobrado. WiinPay só informa `value` já líquido da taxa
   * (ver PR #58), então lá é false — a confirmação registra `amount_is_net`
   * em vez de recusar uma venda legítima por "valor abaixo do cobrado".
   */
  amountIsGross: boolean;
  /** Status cru devolvido pelo gateway (pra log/diagnóstico). */
  rawStatus: string;
  /** Id interno da transação no gateway, quando vem na resposta. */
  gatewayTxId: string | null;
  raw:       unknown;
}

/**
 * Falha TRANSITÓRIA na consulta (rede, timeout, 5xx, 401/403, resposta sem
 * status): não dá pra afirmar nada sobre a cobrança. Quem chama não pode aceitar
 * o status do webhook — responde erro pro gateway reenviar, e a conciliação
 * tenta de novo depois.
 */
export class GatewayStatusUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayStatusUnavailableError";
  }
}

const SYNCPAY_BASE  = "https://api.syncpayments.com.br";
const BUCKPAY_BASE  = "https://api.realtechdev.com.br";
const BUCKPAY_UA    = "Buckpay API"; // mesmo valor do cash-in (gateway-clients.ts)
const NEXUSPAG_BASE = "https://nexuspag.com";
const WIINPAY_BASE  = "https://api-v2.wiinpay.com.br";

// Consulta não pode pendurar o webhook nem o tick da conciliação.
const STATUS_TIMEOUT_MS = 10_000;

// Match EXATO (nunca substring — "unpaid" contém "paid").
const BUCKPAY_PAID_STATUSES = new Set(["paid", "approved", "completed"]);
const WIINPAY_PAID_STATUSES = new Set(["paid", "approved", "completed", "complete", "confirmed", "success", "paid_out"]);

function mapStatus(raw: string, paid: Set<string>): ChargeStatus {
  const s = raw.toLowerCase().trim();
  if (paid.has(s)) return "paid";
  if (s.includes("expir")) return "expired";
  if (s.includes("cancel") || s.includes("refund") || s.includes("fail") || s.includes("refus")
      || s.includes("chargedback") || s.includes("chargeback")) return "cancelled";
  return "pending";
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function reaisToCents(v: unknown): number | null {
  const n = toNumber(v);
  return n === null ? null : Math.round(n * 100);
}

function obj(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) return obj(v[0]);
  return v && typeof v === "object" ? v as Record<string, unknown> : null;
}

/** GET com timeout. null = 404 (cobrança não existe nesta conta). */
async function getJson(url: string, headers: Record<string, string>, onUnauthorized?: () => void): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  } catch (err) {
    throw new GatewayStatusUnavailableError(`falha de rede ao consultar o gateway: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) return null;
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) throw new GatewayStatusUnavailableError(`gateway respondeu HTTP ${res.status} na consulta`);
  try {
    return await res.json();
  } catch {
    throw new GatewayStatusUnavailableError("gateway devolveu resposta não-JSON na consulta");
  }
}

// Token da SyncPay por client_id, reaproveitado entre requisições (webhook e
// conciliação) por um TTL curto — sem isso cada webhook fazia um auth-token a
// mais no gateway. A doc não fixa a validade do token; o SDK de referência usa
// 1h, aqui 10min pra folga. Um 401 na consulta invalida a entrada.
const SYNCPAY_TOKEN_TTL_MS = 10 * 60_000;
const syncpayTokens = new Map<string, { token: string; expiresAt: number }>();
export function __resetSyncpayStatusTokenCacheForTests(): void { syncpayTokens.clear(); }

async function syncpayToken(clientId: string, clientSecret: string): Promise<string> {
  const hit = syncpayTokens.get(clientId);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  let data: { access_token?: string };
  try {
    const res = await fetch(`${SYNCPAY_BASE}/api/partner/v1/auth-token`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body:    JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      signal:  AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    data = await res.json() as { access_token?: string };
  } catch (err) {
    throw new GatewayStatusUnavailableError(`SyncPay auth falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!data.access_token) throw new GatewayStatusUnavailableError("SyncPay auth falhou: sem access_token");
  syncpayTokens.set(clientId, { token: data.access_token, expiresAt: Date.now() + SYNCPAY_TOKEN_TTL_MS });
  return data.access_token;
}

function result(status: string | undefined, paid: Set<string>, amount: number | null, gatewayTxId: unknown, raw: unknown, amountIsGross = true): GatewayChargeStatus {
  if (!status) throw new GatewayStatusUnavailableError("gateway não informou o status da cobrança");
  return {
    status:      mapStatus(status, paid),
    amount,
    amountIsGross,
    rawStatus:   status,
    gatewayTxId: gatewayTxId === undefined || gatewayTxId === null ? null : String(gatewayTxId),
    raw,
  };
}

/**
 * Consulta a cobrança `lookupId` no gateway com a credencial do dono.
 * - devolve o status/valor reais;
 * - devolve null quando o gateway diz que a cobrança não existe (404);
 * - lança GatewayStatusUnavailableError quando não dá pra saber.
 *
 * `lookupId`: para BuckPay é o external_id que NÓS enviamos (gatewayRef); para
 * os demais, o próprio payments.external_id.
 */
export async function fetchChargeStatus(
  provider: Provider,
  creds: { clientId: string; clientSecret: string },
  lookupId: string,
): Promise<GatewayChargeStatus | null> {
  const id = encodeURIComponent(lookupId);
  switch (provider) {
    case "syncpay": {
      const token = await syncpayToken(creds.clientId, creds.clientSecret);
      const json = await getJson(`${SYNCPAY_BASE}/api/partner/v1/transaction/${id}`, {
        Accept: "application/json", Authorization: `Bearer ${token}`,
      }, () => syncpayTokens.delete(creds.clientId));
      if (json === null) return null;
      const d = obj((json as { data?: unknown }).data) ?? obj(json) ?? {};
      // `amount` = bruto (o que payments.amount guarda); final_amount é líquido.
      return result(d.status === undefined ? undefined : String(d.status), SYNCPAY_PAID_STATUSES,
        reaisToCents(d.amount), d.reference_id ?? d.identifier ?? d.id, json);
    }
    case "buckpay": {
      const json = await getJson(`${BUCKPAY_BASE}/v1/transactions/external_id/${id}`, {
        Accept: "application/json", Authorization: `Bearer ${creds.clientId}`, "User-Agent": BUCKPAY_UA,
      });
      if (json === null) return null;
      const d = obj((json as { data?: unknown }).data) ?? {};
      // total_amount já vem em centavos.
      const cents = toNumber(d.total_amount ?? d.amount);
      return result(d.status === undefined ? undefined : String(d.status), BUCKPAY_PAID_STATUSES,
        cents === null ? null : Math.round(cents), d.id, json);
    }
    case "nexuspag": {
      const json = await getJson(`${NEXUSPAG_BASE}/api/pix/${id}`, {
        Accept: "application/json", "x-api-key": creds.clientId,
      });
      if (json === null) return null;
      const root = obj(json) ?? {};
      const d = obj(root.transaction) ?? obj(root.data) ?? root;
      return result(d.status === undefined ? undefined : String(d.status), NEXUSPAG_PAID_STATUSES,
        reaisToCents(d.amount), d.id ?? d.transaction_id, json);
    }
    case "wiinpay": {
      const json = await getJson(`${WIINPAY_BASE}/payment/list/${id}`, {
        Accept: "application/json", Authorization: `Bearer ${creds.clientId}`,
      });
      if (json === null) return null;
      const root = obj(json) ?? {};
      const d = obj(root.payment) ?? obj(root.data) ?? root;
      return result(d.status === undefined ? undefined : String(d.status), WIINPAY_PAID_STATUSES,
        reaisToCents(d.value ?? d.amount), d.paymentId ?? d.id, json, false);
    }
  }
}
