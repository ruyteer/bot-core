import { api } from "encore.dev/api";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { paymentPaid } from "../shared/events/index.js";
import {
  normalizeSyncpayWebhook,
  normalizeBuckpayWebhook,
  normalizeNexuspagWebhook,
  normalizeWiinpayWebhook,
  type NormalizedWebhookEvent,
} from "./application/gateway-clients.js";

const payRepo = new PaymentDrizzleRepository();

// ── Shared handler ────────────────────────────────────────────────────────────

async function processWebhookEvent(event: NormalizedWebhookEvent, rawPayload: unknown, sourceIp?: string): Promise<void> {
  if (!event.externalId) return;

  // Idempotency — skip if already processed with same status
  const already = await payRepo.isProcessed(event.externalId, event.provider);
  if (already) return;

  const payment = await payRepo.findByExternalId(event.externalId, event.provider);

  await payRepo.logWebhook({
    provider:          event.provider,
    externalId:        event.externalId,
    event:             event.event,
    payload:           rawPayload,
    status:            event.status,
    sourceIp,
    matchedPaymentId:  payment?.id,
  });

  if (payment) {
    if (event.status === "paid") {
      await payRepo.markPaid(payment.id, event.amount ?? undefined);
      // Notifica o runner p/ entregar o produto e retomar o funil (ramo __paid).
      await paymentPaid.publish({ paymentId: payment.id });
    } else if (event.status === "cancelled" || event.status === "expired") {
      await payRepo.updateStatus(payment.id, event.status);
    }
  }

  await payRepo.markProcessed(event.externalId, event.provider, event.status);
}

// ── SyncPay ───────────────────────────────────────────────────────────────────

export const syncpayWebhook = api.raw(
  { expose: true, method: "POST", path: "/payments/webhook/syncpay" },
  async (req, resp) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ignore */ }

    resp.writeHead(200);
    resp.end("ok");

    const event = normalizeSyncpayWebhook(body);
    await processWebhookEvent(event, body, req.socket?.remoteAddress).catch(console.error);
  },
);

// ── BuckPay ───────────────────────────────────────────────────────────────────

export const buckpayWebhook = api.raw(
  { expose: true, method: "POST", path: "/payments/webhook/buckpay" },
  async (req, resp) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ignore */ }

    resp.writeHead(200);
    resp.end("ok");

    const event = normalizeBuckpayWebhook(body);
    await processWebhookEvent(event, body, req.socket?.remoteAddress).catch(console.error);
  },
);

// ── NexusPag ──────────────────────────────────────────────────────────────────

export const nexuspagWebhook = api.raw(
  { expose: true, method: "POST", path: "/payments/webhook/nexuspag" },
  async (req, resp) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ignore */ }

    resp.writeHead(200);
    resp.end("ok");

    const event = normalizeNexuspagWebhook(body);
    await processWebhookEvent(event, body, req.socket?.remoteAddress).catch(console.error);
  },
);

// ── WiinPay ───────────────────────────────────────────────────────────────────

export const wiinpayWebhook = api.raw(
  { expose: true, method: "POST", path: "/payments/webhook/wiinpay" },
  async (req, resp) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ignore */ }

    resp.writeHead(200);
    resp.end("ok");

    const event = normalizeWiinpayWebhook(body);
    await processWebhookEvent(event, body, req.socket?.remoteAddress).catch(console.error);
  },
);
