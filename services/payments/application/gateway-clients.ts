import type { PixPaymentResult, Provider } from "../domain/gateway.entity.js";

// ── SyncPay ───────────────────────────────────────────────────────────────────

async function syncpayToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch("https://api.syncpay.pro/api/partner/v1/auth-token", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  const data = await res.json() as { access_token?: string; message?: string };
  if (!data.access_token) throw new Error(data.message ?? "SyncPay auth failed");
  return data.access_token;
}

export async function syncpayCashIn(
  clientId: string, clientSecret: string,
  amountCents: number, description: string, webhookUrl: string,
): Promise<PixPaymentResult> {
  const token = await syncpayToken(clientId, clientSecret);
  const res = await fetch("https://api.syncpay.pro/api/partner/v1/cash-in", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      amount:      amountCents / 100,
      description,
      webhook_url: webhookUrl,
    }),
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

export async function buckpayCashIn(
  apiToken: string,
  amountCents: number, description: string, webhookUrl: string,
): Promise<PixPaymentResult> {
  const res = await fetch("https://api.buckpay.com.br/api/v1/transactions", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      amount:       amountCents / 100,
      payment_type: "pix",
      description,
      callback_url: webhookUrl,
    }),
  });
  const data = await res.json() as { pix_qr_code?: string; id?: string; message?: string; error?: string };
  if (!data.pix_qr_code || !data.id) throw new Error(data.message ?? data.error ?? "BuckPay cashin failed");
  return {
    pixCode:     data.pix_qr_code,
    qrImage:     `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.pix_qr_code)}`,
    externalId:  String(data.id),
    amount:      amountCents,
    provider:    "buckpay",
    institution: "BuckPay",
  };
}

// ── NexusPag ──────────────────────────────────────────────────────────────────

export async function nexuspagCashIn(
  apiKey: string,
  amountCents: number, description: string, webhookUrl: string,
): Promise<PixPaymentResult> {
  const res = await fetch("https://api.nexuspag.com/v1/transactions/pix", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      amount:      amountCents,
      description,
      webhook_url: webhookUrl,
    }),
  });
  const data = await res.json() as { pix_code?: string; id?: string; message?: string };
  if (!data.pix_code || !data.id) throw new Error(data.message ?? "NexusPag cashin failed");
  return {
    pixCode:     data.pix_code,
    qrImage:     `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.pix_code)}`,
    externalId:  String(data.id),
    amount:      amountCents,
    provider:    "nexuspag",
    institution: "NexusPag",
  };
}

// ── WiinPay ───────────────────────────────────────────────────────────────────

export async function wiinpayCashIn(
  apiKey: string,
  amountCents: number, description: string, webhookUrl: string,
): Promise<PixPaymentResult> {
  const res = await fetch("https://api.wiinpay.com.br/api/v1/pix/charge", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      amount:      amountCents / 100,
      description,
      webhook_url: webhookUrl,
    }),
  });
  const data = await res.json() as { pix_copy_paste?: string; id?: string; message?: string };
  if (!data.pix_copy_paste || !data.id) throw new Error(data.message ?? "WiinPay cashin failed");
  return {
    pixCode:     data.pix_copy_paste,
    qrImage:     `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.pix_copy_paste)}`,
    externalId:  String(data.id),
    amount:      amountCents,
    provider:    "wiinpay",
    institution: "WiinPay",
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function createPix(
  provider: Provider,
  clientId: string,
  clientSecret: string,
  amountCents: number,
  description: string,
  webhookUrl: string,
): Promise<PixPaymentResult> {
  switch (provider) {
    case "syncpay":  return syncpayCashIn(clientId, clientSecret, amountCents, description, webhookUrl);
    case "buckpay":  return buckpayCashIn(clientId, amountCents, description, webhookUrl);
    case "nexuspag": return nexuspagCashIn(clientId, amountCents, description, webhookUrl);
    case "wiinpay":  return wiinpayCashIn(clientId, amountCents, description, webhookUrl);
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
  const identifier = (body.identifier ?? body.transaction_id) as string | undefined;
  const statusRaw  = (body.status ?? body.event) as string | undefined;
  const isPaid     = statusRaw?.toLowerCase().includes("paid") || statusRaw?.toLowerCase().includes("approved") || statusRaw?.toLowerCase().includes("success");
  const isCancelled = statusRaw?.toLowerCase().includes("cancel") || statusRaw?.toLowerCase().includes("refund");
  const isExpired  = statusRaw?.toLowerCase().includes("expir");
  const status     = isPaid ? "paid" : isCancelled ? "cancelled" : isExpired ? "expired" : "pending";
  return {
    externalId: identifier ?? "",
    provider:   "syncpay",
    status,
    amount:     typeof body.amount === "number" ? Math.round(body.amount * 100) : null,
    event:      statusRaw ?? "",
  };
}

export function normalizeBuckpayWebhook(body: Record<string, unknown>): NormalizedWebhookEvent {
  const id      = String(body.id ?? body.transaction_id ?? "");
  const statusRaw = (body.status ?? "") as string;
  const isPaid  = statusRaw === "paid" || statusRaw === "approved" || statusRaw === "completed";
  const status  = isPaid ? "paid" : statusRaw === "cancelled" ? "cancelled" : statusRaw === "expired" ? "expired" : "pending";
  return {
    externalId: id,
    provider:   "buckpay",
    status,
    amount:     typeof body.amount === "number" ? Math.round(body.amount * 100) : null,
    event:      statusRaw,
  };
}

export function normalizeNexuspagWebhook(body: Record<string, unknown>): NormalizedWebhookEvent {
  const id        = String(body.id ?? body.transaction_id ?? "");
  const statusRaw = (body.status ?? "") as string;
  const isPaid    = statusRaw === "paid" || statusRaw === "approved";
  const status    = isPaid ? "paid" : statusRaw === "cancelled" ? "cancelled" : "pending";
  return {
    externalId: id,
    provider:   "nexuspag",
    status,
    amount:     typeof body.amount === "number" ? body.amount : null,
    event:      statusRaw,
  };
}

export function normalizeWiinpayWebhook(body: Record<string, unknown>): NormalizedWebhookEvent {
  const id        = String(body.id ?? body.charge_id ?? "");
  const statusRaw = (body.status ?? body.event ?? "") as string;
  const isPaid    = statusRaw === "paid" || statusRaw === "approved" || statusRaw === "PAID";
  const status    = isPaid ? "paid" : statusRaw === "cancelled" ? "cancelled" : "pending";
  return {
    externalId: id,
    provider:   "wiinpay",
    status,
    amount:     typeof body.amount === "number" ? Math.round(body.amount * 100) : null,
    event:      statusRaw,
  };
}
