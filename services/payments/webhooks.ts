import { api } from "encore.dev/api";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { paymentPaid } from "../shared/events/index.js";
import { sendPushToUser } from "../notifications/application/send-push.use-case.js";
import { accrueReferralCommission } from "../referrals/application/accrue-commission.js";
import { enqueuePixelEvents } from "../bots/application/pixel-events.js";
import { db } from "../shared/database.js";
import { paymentRevenueCredits } from "../shared/schema/index.js";
import { isPlatformAdmin } from "../shared/roles.js";
import type { Provider } from "./domain/gateway.entity.js";
import type { Payment } from "./domain/payment.entity.js";
import {
  normalizeSyncpayWebhook,
  normalizeBuckpayWebhook,
  normalizeNexuspagWebhook,
  normalizeWiinpayWebhook,
  platformSplitCents,
  splitConfiguredFor,
  type NormalizedWebhookEvent,
} from "./application/gateway-clients.js";

// Valor em centavos -> "R$ 12,34"
function formatBRL(cents: number): string {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const payRepo = new PaymentDrizzleRepository();

// ── Receita da plataforma (payment_revenue_credits) ───────────────────────────
// O split é aplicado NO PROVEDOR na criação do PIX (createPix) e nunca voltava
// pra cá — `payment_revenue_credits` ficava vazia e o card "Taxas" do admin
// mostrava R$ 0,00 pra sempre. Aqui reconstruímos o mesmo valor que o split
// carregou, na confirmação do pagamento, usando a mesma fonte da verdade de
// `application/gateway-clients.ts` (splitConfiguredFor/platformSplitCents).

// Lança o crédito de receita da plataforma. Idempotente pela PK composta
// (payment_id, user_id) — o webhook pode ser reentregue. Nunca derruba a
// confirmação da venda.
async function creditPlatformRevenue(payment: Payment, provider: Provider): Promise<void> {
  try {
    // Admin da plataforma gera PIX sem split (createPixWithFallback -> skipSplit),
    // então não há taxa nenhuma a creditar.
    if (await isPlatformAdmin(payment.userId)) return;
    if (!splitConfiguredFor(provider)) return;
    // Base = o mesmo amountCents passado ao createPix na criação da cobrança.
    const fee = platformSplitCents(provider, payment.amount);
    if (fee <= 0) return;
    await db.insert(paymentRevenueCredits).values({
      paymentId: payment.id,
      userId:    payment.userId,
      amount:    fee,
      provider,
    }).onConflictDoNothing();
  } catch (err) {
    console.error("[payments] falha ao creditar receita da plataforma:", err);
  }
}

// ── Shared handler ────────────────────────────────────────────────────────────

export async function processWebhookEvent(event: NormalizedWebhookEvent, rawPayload: unknown, sourceIp?: string): Promise<void> {
  // Candidatos = TODOS os ids plausíveis extraídos do payload (normalizeXWebhook).
  // Para buckpay/wiinpay isso é só [externalId] de sempre; para syncpay/nexuspag
  // pode ter vários, porque o campo que bate com payments.external_id varia
  // entre criação e webhook (ver gateway-clients.ts). primaryId é o candidato
  // #1, usado só pra idempotência/log — o match de verdade tenta todos.
  const candidates = event.externalIdCandidates && event.externalIdCandidates.length > 0
    ? event.externalIdCandidates
    : (event.externalId ? [event.externalId] : []);
  const primaryId = event.externalId || candidates[0] || "";

  // Um `return` mudo aqui era o pior lugar possível para não deixar rastro: é
  // exatamente o caso em que o payload do provedor não bate com o que o
  // normalizador espera, e o único jeito de descobrir a forma real é vendo o
  // corpo que ele mandou. Sem log, "o provedor nunca chamou" e "chamou e não
  // entendemos" ficam indistinguíveis — e é a primeira pergunta de qualquer
  // investigação de venda não confirmada. Registra e só então desiste.
  if (candidates.length === 0) {
    await payRepo.logWebhook({
      provider:     event.provider,
      event:        event.event,
      payload:      rawPayload,
      status:       event.status,
      amount:       event.amount,
      sourceIp,
      errorMessage: "sem identificador: o normalizador não achou nenhum id de transação neste payload",
    });
    return;
  }

  // Idempotency — skip if already processed with the SAME status. Status faz
  // parte da chave de propósito: uma venda gera vários webhooks com o mesmo
  // externalId ao longo do tempo (ex.: SyncPay manda "pending"/
  // "waiting_for_approval" na criação e só depois "paid_out" na confirmação)
  // — dedupar só por (externalId, provider) fazia o primeiro webhook (quase
  // sempre o de venda pendente) travar a venda pra sempre, descartando o
  // webhook de pagamento confirmado antes mesmo dele ser logado.
  const already = await payRepo.isProcessed(primaryId, event.provider, event.status);
  if (already) return;

  const payment = await payRepo.findByAnyExternalId(candidates, event.provider);

  await payRepo.logWebhook({
    provider:          event.provider,
    externalId:        primaryId,
    event:             event.event,
    payload:           rawPayload,
    status:            event.status,
    amount:            event.amount,
    sourceIp,
    matchedPaymentId:  payment?.id,
    // processed=true só quando achamos o pagamento; sem isso todo webhook
    // ficava com processed=false pra sempre e a tela de logs nunca marcava
    // nada como "ok" — mesmo os que confirmaram vendas com sucesso.
    processed:         !!payment,
    // Nenhum candidato bateu: quase sempre significa que gravamos um id na
    // criação e o provedor devolve outro(s) no webhook. Lista os candidatos
    // tentados — é assim que confirmamos em produção se o fix pegou todos os
    // casos ou se falta mais um campo pra cobrir.
    ...(payment ? {} : {
      errorMessage: `id "${primaryId}" não corresponde a nenhum pagamento de ${event.provider} (candidatos tentados: [${candidates.join(", ")}])`,
    }),
  });

  if (payment) {
    if (event.status === "paid") {
      await payRepo.markPaid(payment.id, event.amount ?? undefined);

      // Receita da plataforma (card "Taxas" do admin): persiste o valor que o
      // split reteve nesta transação. Idempotente; trata os próprios erros.
      await creditPlatformRevenue(payment, event.provider);

      // Notifica o runner p/ entregar o produto e retomar o funil (ramo __paid).
      await paymentPaid.publish({ paymentId: payment.id });

      // Indique e Ganhe: credita a comissão do indicador do seller (se houver).
      // Trata os próprios erros — nunca bloqueia a confirmação da venda.
      await accrueReferralCommission(payment.id, payment.userId);

      // Pixels: Purchase para cada pixel ativo do bot (enviado pelo tick do
      // runner). Idempotente pelo processedWebhooks — este bloco roda uma vez.
      await enqueuePixelEvents(payment.botId, "Purchase", {
        leadId: payment.leadId, paymentId: payment.id,
      });

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

  await payRepo.markProcessed(primaryId, event.provider, event.status);
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
