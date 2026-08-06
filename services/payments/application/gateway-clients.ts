import { randomUUID } from "node:crypto";
import type { PixPaymentResult, Provider } from "../domain/gateway.entity.js";
import { syncpaySplitUserId, nexuspagSplitUserId, wiinpaySplitUserId, buckpaySplitEmail } from "../../config/secrets.js";

// Split de monetização da plataforma: R$0,40 por transação. O `receiverId` é a
// conta da plataforma no PSP (secret por provider); quando null, sem split.
export const PLATFORM_SPLIT_CENTS = 40;

// Extrai uma mensagem legível de um erro de gateway que pode vir como string,
// { message } ou objeto. Sem isso, `throw new Error(obj)` virava "[object Object]"
// e escondia a causa real (ex.: WiinPay "Split não pode ser para o próprio recebedor").
function errMsg(...cands: unknown[]): string {
  for (const c of cands) {
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c === "object") {
      const m = (c as { message?: unknown }).message;
      if (typeof m === "string" && m.trim()) return m;
      try { return JSON.stringify(c); } catch { /* ignore */ }
    }
  }
  return "erro desconhecido do gateway";
}

// Recebedor do split por provider, vindo dos secrets da plataforma. Vazio (secret
// não configurado) = split desligado nesse gateway, e o PIX segue sem split.
// SyncPay/NexusPag/WiinPay: user_id/client_id. BuckPay: e-mail cadastrado na Buck.
function splitReceiverFor(provider: Provider): string | null {
  const read = (fn: () => string): string | null => {
    try { return (fn() || "").trim() || null; } catch { return null; }
  };
  switch (provider) {
    case "syncpay":  return read(syncpaySplitUserId);
    case "nexuspag": return read(nexuspagSplitUserId);
    case "wiinpay":  return read(wiinpaySplitUserId);
    case "buckpay":  return read(buckpaySplitEmail);
    default:         return null;
  }
}

// SyncPay só aceita split em PERCENTUAL INTEIRO. Escolhe o menor % cujo valor
// atinja ou passe os 40c (min 1%, cap 99%). Em ticket > R$40, 1% já passa de 40c
// — limitação da SyncPay, aceita (o valor fixo exato só existe em wiinpay/nexuspag).
function syncpaySplitPercentage(amountCents: number): number {
  const p = Math.ceil((PLATFORM_SPLIT_CENTS * 100) / amountCents);
  return Math.max(1, Math.min(99, p));
}

// BuckPay: split em basis points (1 bp = 0,01%), min 1 / max 9000, calculado
// sobre o líquido. Convertemos os 40c fixos p/ bps sobre o valor bruto (não
// sabemos a taxa no momento da criação) — aproximado, arredondando pra cima.
function buckpaySplitBps(amountCents: number): number {
  const bps = Math.ceil((PLATFORM_SPLIT_CENTS / amountCents) * 10000);
  return Math.max(1, Math.min(9000, bps));
}

// ── SyncPay ───────────────────────────────────────────────────────────────────
// Domínio antigo api.syncpay.pro está MORTO; o atual é api.syncpayments.com.br.
const SYNCPAY_BASE = "https://api.syncpayments.com.br";

async function syncpayToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${SYNCPAY_BASE}/api/partner/v1/auth-token`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  const data = await res.json() as { access_token?: string; message?: string };
  if (!data.access_token) throw new Error(data.message ?? "SyncPay auth failed");
  return data.access_token;
}

// A SyncPay IGNORA o campo webhook_url do cash-in: a doc diz que webhooks são
// enviados SOMENTE a partir do cadastro na conta (POST /api/partner/v1/webhooks,
// evento "cashin"). Sem esse cadastro, o PIX gera mas a confirmação de venda
// nunca chega. Registramos o webhook na primeira cobrança de cada conta
// (cache por processo; falha não bloqueia o PIX — tenta de novo na próxima).
const syncpayWebhookEnsured = new Set<string>();
export function __resetSyncpayWebhookCacheForTests(): void { syncpayWebhookEnsured.clear(); }

async function ensureSyncpayWebhook(token: string, clientId: string, webhookUrl: string): Promise<void> {
  if (syncpayWebhookEnsured.has(clientId)) return;
  try {
    const listRes = await fetch(`${SYNCPAY_BASE}/api/partner/v1/webhooks`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    const listData = await listRes.json().catch(() => null) as unknown;
    const rows: Array<Record<string, unknown>> =
      Array.isArray(listData) ? listData as Array<Record<string, unknown>>
      : Array.isArray((listData as { data?: unknown })?.data) ? (listData as { data: Array<Record<string, unknown>> }).data
      : [];
    const exists = rows.some((w) =>
      String(w.url ?? "") === webhookUrl && ["cashin", "all"].includes(String(w.event ?? "")));

    if (!exists) {
      const createRes = await fetch(`${SYNCPAY_BASE}/api/partner/v1/webhooks`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: "OrionBot — confirmação de venda (cashin)",
          url:   webhookUrl,
          event: "cashin",
          trigger_all_products: true,
        }),
      });
      if (!createRes.ok) {
        console.error("[syncpay] registro do webhook falhou:", createRes.status, await createRes.text().catch(() => ""));
        return; // sem cache → nova tentativa no próximo PIX
      }
      console.log(`[syncpay] webhook cashin registrado: ${webhookUrl}`);
    }
    syncpayWebhookEnsured.add(clientId);
  } catch (err) {
    console.error("[syncpay] ensureWebhook falhou:", err);
  }
}

export async function syncpayCashIn(
  clientId: string, clientSecret: string,
  amountCents: number, description: string, webhookUrl: string,
  splitReceiverId?: string | null,
): Promise<PixPaymentResult> {
  const token = await syncpayToken(clientId, clientSecret);
  await ensureSyncpayWebhook(token, clientId, webhookUrl);
  const body: Record<string, unknown> = {
    amount:      amountCents / 100, // reais
    description,
    webhook_url: webhookUrl,
  };
  if (splitReceiverId) {
    body.split = [{ percentage: syncpaySplitPercentage(amountCents), user_id: splitReceiverId }];
  }
  const res = await fetch(`${SYNCPAY_BASE}/api/partner/v1/cash-in`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { pix_code?: string; identifier?: string; message?: string };
  if (!data.pix_code || !data.identifier) throw new Error(data.message ?? "SyncPay cashin failed");
  return {
    pixCode:     data.pix_code,
    qrImage:     `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.pix_code)}`,
    externalId:  data.identifier,
    amount:      amountCents,
    provider:    "syncpay",
    institution: "SyncPay",
  };
}

// ── BuckPay ───────────────────────────────────────────────────────────────────
// API real fica em api.realtechdev.com.br (white-label). Doc: docs.buckpay.com.br.
// O header User-Agent é OBRIGATÓRIO e específico da conta (fornecido pelo gerente
// de contas da BuckPay) — sem o valor correto a requisição é rejeitada.
const BUCKPAY_BASE_URL   = "https://api.realtechdev.com.br";
const BUCKPAY_USER_AGENT = "Buckpay API"; // valor fornecido pelo gerente de contas BuckPay

export async function buckpayCashIn(
  apiToken: string,
  amountCents: number, description: string, webhookUrl: string,
  splitReceiverEmail?: string | null,
): Promise<PixPaymentResult> {
  const body: Record<string, unknown> = {
    external_id:    randomUUID(),
    payment_method: "pix",
    amount:         Math.round(amountCents), // centavos, inteiro (mín. 600)
    postbackUrl:    webhookUrl,
  };
  if (splitReceiverEmail) {
    // Split por e-mail + basis points (percentual). O recebedor precisa estar
    // cadastrado na Buck. Calculado sobre o líquido.
    body.splits = [{ email: splitReceiverEmail, percentage_bps: buckpaySplitBps(amountCents) }];
  }
  const res = await fetch(`${BUCKPAY_BASE_URL}/v1/transactions`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":   BUCKPAY_USER_AGENT,
      Authorization:  `Bearer ${apiToken}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json() as {
    data?:  { id?: string; pix?: { code?: string; qrcode_base64?: string } };
    error?: { message?: string; detail?: unknown };
    message?: string;
  };
  const tx = json.data;
  if (!res.ok || !tx?.id || !tx.pix?.code) {
    const msg    = json.error?.message ?? json.message ?? "BuckPay cashin failed";
    const detail = json.error?.detail ? ` detail=${JSON.stringify(json.error.detail)}` : "";
    throw new Error(`BuckPay ${res.status}: ${msg}${detail}`);
  }
  return {
    pixCode:     tx.pix.code,
    // A API devolve o QR em base64, mas o Telegram só aceita URL/file_id no campo
    // `photo` (não data-URI), então gera a imagem via qrserver a partir do código.
    qrImage:     `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(tx.pix.code)}`,
    externalId:  String(tx.id),
    amount:      amountCents,
    provider:    "buckpay",
    institution: "BuckPay",
  };
}

// ── NexusPag ──────────────────────────────────────────────────────────────────
// Base nexuspag.com; endpoint /api/pix/create; valor em REAIS; auth x-api-key.
const NEXUSPAG_BASE = "https://nexuspag.com";

export async function nexuspagCashIn(
  apiKey: string,
  amountCents: number, description: string, webhookUrl: string,
  splitReceiverId?: string | null,
): Promise<PixPaymentResult> {
  const body: Record<string, unknown> = {
    amount:      amountCents / 100, // reais
    description,
    external_id: randomUUID(),
    webhook_url: webhookUrl,
  };
  if (splitReceiverId) {
    // Valor fixo em reais (split user-to-user entre contas da plataforma).
    body.split = [{ user_id: splitReceiverId, amount: PLATFORM_SPLIT_CENTS / 100 }];
  }
  const res = await fetch(`${NEXUSPAG_BASE}/api/pix/create`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json() as {
    success?:     boolean;
    transaction?: { id?: string; txid?: string; pix_copia_cola?: string; qr_code_base64?: string };
    message?:     string;
    error?:       string;
  };
  const tx = json.transaction;
  if (!res.ok || !tx?.id || !tx.pix_copia_cola) {
    throw new Error(errMsg(json.error, json.message, "NexusPag cashin failed"));
  }
  return {
    pixCode:     tx.pix_copia_cola,
    qrImage:     `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(tx.pix_copia_cola)}`,
    externalId:  String(tx.id),
    amount:      amountCents,
    provider:    "nexuspag",
    institution: "NexusPag",
  };
}

// ── WiinPay ───────────────────────────────────────────────────────────────────
// Base api-v2 (api.wiinpay.com.br dá 522); endpoint /payment/create; api_key NO
// BODY (não header); valor em REAIS (mín. R$3); `name`/`email` são obrigatórios.
const WIINPAY_BASE = "https://api-v2.wiinpay.com.br";

export async function wiinpayCashIn(
  apiKey: string,
  amountCents: number, description: string, webhookUrl: string,
  splitReceiverId?: string | null,
): Promise<PixPaymentResult> {
  const body: Record<string, unknown> = {
    api_key:     apiKey,
    value:       amountCents / 100, // reais
    // Não coletamos os dados do pagador no bot; a WiinPay só exige presença.
    name:        "Cliente",
    email:       "cliente@orionbot.app",
    description,
    webhook_url: webhookUrl,
  };
  if (splitReceiverId) {
    // Objeto (não array), valor fixo em reais.
    body.split = { value: PLATFORM_SPLIT_CENTS / 100, user_id: splitReceiverId };
  }
  const res = await fetch(`${WIINPAY_BASE}/payment/create`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  // A resposta REAL aninha tudo em `data` e o id é `paymentId` (a doc dizia flat
  // com `id` — confirmado errado no teste ao vivo 2026-07-25).
  const json = await res.json() as {
    data?:    { qr_code?: string; paymentId?: string; id?: string; message?: string };
    message?: string; error?: string;
  };
  const d = json.data ?? {};
  const pix = d.qr_code;
  const id  = d.paymentId ?? d.id;
  if (!res.ok || !pix || !id) throw new Error(errMsg(json.error, d.message, json.message, "WiinPay cashin failed"));
  return {
    pixCode:     pix,
    qrImage:     `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pix)}`,
    externalId:  String(id),
    amount:      amountCents,
    provider:    "wiinpay",
    institution: "WiinPay",
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export interface CreatePixOpts {
  // Admin não paga a taxa da plataforma: pula o split (o PIX vira 100% do vendedor).
  skipSplit?: boolean;
}

export async function createPix(
  provider: Provider,
  clientId: string,
  clientSecret: string,
  amountCents: number,
  description: string,
  webhookUrl: string,
  opts?: CreatePixOpts,
): Promise<PixPaymentResult> {
  const split = opts?.skipSplit ? null : splitReceiverFor(provider);
  switch (provider) {
    case "syncpay":  return syncpayCashIn(clientId, clientSecret, amountCents, description, webhookUrl, split);
    case "buckpay":  return buckpayCashIn(clientId, amountCents, description, webhookUrl, split);
    case "nexuspag": return nexuspagCashIn(clientId, amountCents, description, webhookUrl, split);
    case "wiinpay":  return wiinpayCashIn(clientId, amountCents, description, webhookUrl, split);
  }
}

// ── Webhook normalizer — each gateway has different payload shapes ─────────────

export interface NormalizedWebhookEvent {
  externalId: string;
  provider:   Provider;
  status:     "paid" | "pending" | "cancelled" | "expired" | "unknown";
  amount:     number | null;
  event:      string;
}

export function normalizeSyncpayWebhook(body: Record<string, unknown>): NormalizedWebhookEvent {
  // O webhook novo aninha a transação em `data` (status "completed" = pago); o
  // padrão OLD (do campo webhook_url) pode vir plano. Lemos os dois.
  const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  const identifier = (data.id ?? data.identifier ?? body.identifier ?? body.transaction_id) as string | undefined;
  const statusRaw  = String((data.status ?? body.status ?? body.event) ?? "").toLowerCase();
  const isPaid     = statusRaw.includes("paid") || statusRaw.includes("approved") || statusRaw.includes("success") || statusRaw.includes("complet");
  const isCancelled = statusRaw.includes("cancel") || statusRaw.includes("refund");
  const isExpired  = statusRaw.includes("expir");
  const status     = isPaid ? "paid" : isCancelled ? "cancelled" : isExpired ? "expired" : "pending";
  // amount/final_amount vêm em REAIS.
  const amountRaw  = data.final_amount ?? data.amount ?? body.amount;
  return {
    externalId: identifier ?? "",
    provider:   "syncpay",
    status,
    amount:     typeof amountRaw === "number" ? Math.round(amountRaw * 100) : null,
    event:      String((data.status ?? body.event) ?? ""),
  };
}

export function normalizeBuckpayWebhook(body: Record<string, unknown>): NormalizedWebhookEvent {
  // O webhook (evento transaction-processed) traz a transação aninhada em `data`,
  // mesmo shape da resposta de criação; mantém fallback p/ payload plano por segurança.
  const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  const id        = String(data.id ?? data.transaction_id ?? data.external_id ?? "");
  const statusRaw = String(data.status ?? body.event ?? "");
  const isPaid    = statusRaw === "paid" || statusRaw === "approved" || statusRaw === "completed";
  const status    = isPaid ? "paid" : statusRaw === "cancelled" ? "cancelled" : statusRaw === "expired" ? "expired" : "pending";
  // total_amount já vem em centavos (inteiro).
  const amountRaw = data.total_amount ?? data.amount;
  return {
    externalId: id,
    provider:   "buckpay",
    status,
    amount:     typeof amountRaw === "number" ? Math.round(amountRaw) : null,
    event:      String(body.event ?? statusRaw),
  };
}

export function normalizeNexuspagWebhook(body: Record<string, unknown>): NormalizedWebhookEvent {
  // A criação devolve a transação em `transaction`; o webhook pode vir aninhado
  // assim ou plano — cobrimos os dois.
  const tx = (body.transaction && typeof body.transaction === "object" ? body.transaction : body) as Record<string, unknown>;
  const id        = String(tx.id ?? tx.txid ?? body.id ?? body.transaction_id ?? "");
  const statusRaw = String((tx.status ?? body.status) ?? "").toLowerCase();
  const isPaid    = statusRaw.includes("paid") || statusRaw.includes("approved") || statusRaw.includes("complet");
  const status    = isPaid ? "paid" : statusRaw.includes("cancel") ? "cancelled" : statusRaw.includes("expir") ? "expired" : "pending";
  // amount em REAIS.
  const amountRaw = tx.amount ?? tx.net_amount ?? body.amount;
  return {
    externalId: id,
    provider:   "nexuspag",
    status,
    amount:     typeof amountRaw === "number" ? Math.round(amountRaw * 100) : null,
    event:      statusRaw,
  };
}

export function normalizeWiinpayWebhook(body: Record<string, unknown>): NormalizedWebhookEvent {
  const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  // A criação usa `paymentId` como id (resposta aninhada em data) — o webhook
  // deve seguir o mesmo shape.
  const id        = String(data.paymentId ?? data.id ?? data.charge_id ?? body.id ?? "");
  const statusRaw = String((data.status ?? body.status ?? body.event) ?? "").toLowerCase();
  const isPaid    = statusRaw.includes("paid") || statusRaw.includes("approved") || statusRaw.includes("complet");
  const status    = isPaid ? "paid" : statusRaw.includes("cancel") ? "cancelled" : statusRaw.includes("expir") ? "expired" : "pending";
  // WiinPay usa `value` (REAIS), não `amount`.
  const amountRaw = data.value ?? data.amount ?? body.value;
  return {
    externalId: id,
    provider:   "wiinpay",
    status,
    amount:     typeof amountRaw === "number" ? Math.round(amountRaw * 100) : null,
    event:      statusRaw,
  };
}
