import { api } from "encore.dev/api";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { paymentPaid } from "../shared/events/index.js";
import { sendPushToUser } from "../notifications/application/send-push.use-case.js";
import { accrueReferralCommission } from "../referrals/application/accrue-commission.js";
import {
  normalizeSyncpayWebhook,
  normalizeBuckpayWebhook,
  normalizeNexuspagWebhook,
  normalizeWiinpayWebhook,
  type NormalizedWebhookEvent,
} from "./application/gateway-clients.js";

// Valor em centavos -> "R$ 12,34"
function formatBRL(cents: number): string {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const payRepo = new PaymentDrizzleRepository();

// ── Shared handler ────────────────────────────────────────────────────────────

export async function processWebhookEvent(event: NormalizedWebhookEvent, rawPayload: unknown, sourceIp?: string): Promise<void> {
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

      // Indique e Ganhe: credita a comissão do indicador do seller (se houver).
      // Trata os próprios erros — nunca bloqueia a confirmação da venda.
      await accrueReferralCommission(payment.id, payment.userId);

      // Push para o dono do bot. Não bloqueia nem derruba a confirmação da venda:
      // sendPushToUser trata os próprios erros, e o catch aqui é só cinto extra.
      const amount = event.amount ?? payment.amount;
      void sendPushToUser(payment.userId, {
        eventType: "sale",
        title:     "💰 Venda aprovada!",
        body:      `${payment.offerName || "Pagamento"} — ${formatBRL(amount)}`,
        data:      { url: "/sales", payment_id: payment.id },
      }).catch((err) => console.error("[payments] push de venda falhou:", err));
    } else if (event.status === "cancelled" || event.status === "expired") {
      await payRepo.updateStatus(payment.id, event.status);
    }
  }

  await payRepo.markProcessed(event.externalId, event.provider, event.status);
}

// ── Helper p/ os 4 endpoints raw (lê body JSON, responde 200, processa) ─────────

async function readJsonBody(req: AsyncIterable<Buffer>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}

// ── SyncPay ───────────────────────────────────────────────────────────────────

export const syncpayWebhook = api.raw(
  { expose: true, method: "POST", path: "/payments/webhook/syncpay" },
  async (req, resp) => {
    const body = await readJsonBody(req);
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
    const body = await readJsonBody(req);
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
    const body = await readJsonBody(req);
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
    const body = await readJsonBody(req);
    resp.writeHead(200);
    resp.end("ok");
    const event = normalizeWiinpayWebhook(body);
    await processWebhookEvent(event, body, req.socket?.remoteAddress).catch(console.error);
  },
);
