import { api } from "encore.dev/api";
import { eq } from "drizzle-orm";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { paymentPaid } from "../shared/events/index.js";
import { sendPushToUser, PUSH_EVENT_TYPES, formatBotHandle } from "../notifications/application/send-push.use-case.js";
import { accrueReferralCommission } from "../referrals/application/accrue-commission.js";
import { enqueuePixelEvents } from "../bots/application/pixel-events.js";
import { db } from "../shared/database.js";
import { paymentRevenueCredits, bots } from "../shared/schema/index.js";
import type { Provider } from "./domain/gateway.entity.js";
import type { Payment } from "./domain/payment.entity.js";
import {
  normalizeSyncpayWebhook,
  normalizeBuckpayWebhook,
  normalizeNexuspagWebhook,
  normalizeWiinpayWebhook,
  platformSplitCents,
  type NormalizedWebhookEvent,
} from "./application/gateway-clients.js";
import { resolveEffectiveSplit, type EffectiveSplit } from "./application/split-config.js";
import { canTransition, checkPaidAmount } from "./domain/payment-status.js";

// Valor em centavos -> "R$ 12,34"
function formatBRL(cents: number): string {
  return (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const payRepo = new PaymentDrizzleRepository();

// ── Receita da plataforma (payment_revenue_credits) ───────────────────────────
// O split é aplicado NO PROVEDOR na criação do PIX (createPix) e nunca voltava
// pra cá — `payment_revenue_credits` ficava vazia e o card "Taxas" do admin
// mostrava R$ 0,00 pra sempre. Aqui persistimos o valor que o split carregou.
//
// Fonte: o snapshot gravado NA CRIAÇÃO da cobrança (payments.split_snapshot,
// via createPixWithFallback). Antes a confirmação resolvia o split de novo na
// hora do webhook — se o painel mudasse entre o PIX e o pagamento (split
// desligado/ligado, taxa do usuário alterada), receita e comissão divergiam do
// que o gateway de fato reteve.

interface ConfirmationSplit {
  /** Taxa-alvo (centavos) — base da comissão de indicação. */
  cents:    number;
  /** Quanto o gateway reteve de fato — receita da plataforma. */
  feeCents: number;
}

// resolveEffectiveSplit não pode derrubar a confirmação da venda — mesmo
// espírito de isPlatformAdmin (roles.ts): falha silenciosa vira "sem split".
async function safeResolveSplit(provider: Provider, ownerUserId: string): Promise<EffectiveSplit | null> {
  try {
    return await resolveEffectiveSplit(provider, ownerUserId);
  } catch (err) {
    console.error("[payments] falha ao resolver split efetivo:", err);
    return null;
  }
}

// Split desta venda: o snapshot da criação; só cobranças anteriores à
// migration 0021 (sem snapshot) caem no cálculo antigo, feito na hora.
async function splitForConfirmation(payment: Payment, provider: Provider): Promise<ConfirmationSplit | null> {
  const snap = payment.splitSnapshot;
  if (snap) return snap.cents > 0 ? { cents: snap.cents, feeCents: snap.feeCents } : null;
  const split = await safeResolveSplit(provider, payment.userId);
  if (!split) return null;
  return { cents: split.cents, feeCents: platformSplitCents(provider, payment.amount, split.cents) };
}

// Lança o crédito de receita da plataforma. Idempotente pela PK composta
// (payment_id, user_id) — o webhook pode ser reentregue. Nunca derruba a
// confirmação da venda.
async function creditPlatformRevenue(payment: Payment, provider: Provider, split: ConfirmationSplit | null): Promise<void> {
  try {
    if (!split || split.feeCents <= 0) return; // admin, split desligado, ou taxa zerada — nada a creditar
    await db.insert(paymentRevenueCredits).values({
      paymentId: payment.id,
      userId:    payment.userId,
      amount:    split.feeCents,
      provider,
    }).onConflictDoNothing();
  } catch (err) {
    console.error("[payments] falha ao creditar receita da plataforma:", err);
  }
}

// Efeitos IDEMPOTENTES da venda paga: receita (PK), comissão (UNIQUE
// payment_id) e o evento paymentPaid (o subscriber do runner reivindica a
// entrega com claimDelivery — mensagem repetida não entrega de novo). Por serem
// seguros de repetir, rodam também na recuperação de um "pago" que ficou sem
// entrega (ver ramo already_paid em processWebhookEvent).
async function applyIdempotentPaidEffects(payment: Payment, provider: Provider): Promise<void> {
  const split = await splitForConfirmation(payment, provider);

  // Receita da plataforma (card "Taxas" do admin). Trata os próprios erros.
  await creditPlatformRevenue(payment, provider, split);

  // Notifica o runner p/ entregar o produto e retomar o funil (ramo __paid).
  await paymentPaid.publish({ paymentId: payment.id });

  // Indique e Ganhe: credita a comissão do indicador do seller (se houver
  // split real nesta venda — sem split, não há taxa da plataforma sobre a
  // qual comissionar). Trata os próprios erros — nunca bloqueia a venda.
  if (split) {
    await accrueReferralCommission(payment.id, payment.userId, split.cents);
  }
}

// Efeitos da venda que acabou de ser confirmada — roda só pra quem ganhou a
// transição atômica pending/expired → paid, ou seja, uma vez por venda.
async function onPaymentConfirmed(payment: Payment, event: NormalizedWebhookEvent): Promise<void> {
  await applyIdempotentPaidEffects(payment, event.provider);

  // Pixels: Purchase para cada pixel ativo do bot (enviado pelo tick do
  // runner). NÃO é idempotente — por isso só aqui, depois da transição.
  await enqueuePixelEvents(payment.botId, "Purchase", {
    leadId: payment.leadId, paymentId: payment.id,
  });

  // Push para o dono do bot. Não bloqueia nem derruba a confirmação da venda:
  // sendPushToUser trata os próprios erros, e o catch aqui é só cinto extra.
  // Diferente do runner, aqui só temos o payment em mãos — sem o bot já
  // carregado em escopo — daí o lookup extra por telegramUsername.
  const amount = event.amount ?? payment.amount;
  const pushBot = await db.select({ telegramUsername: bots.telegramUsername })
    .from(bots).where(eq(bots.id, payment.botId)).limit(1)
    .then((rows) => rows[0])
    .catch((err) => { console.error("[payments] lookup de bot p/ push falhou:", err); return undefined; });
  void sendPushToUser(payment.userId, {
    eventType: PUSH_EVENT_TYPES.SALE_APPROVED,
    title:     "💰 Venda aprovada!",
    body:      `${formatBotHandle(pushBot?.telegramUsername)} · ${payment.offerName || "Pagamento"} — ${formatBRL(amount)}`,
    data:      { url: "/sales", payment_id: payment.id },
  }).catch((err) => console.error("[payments] push de venda falhou:", err));
}

// ── Caso de uso de confirmação ────────────────────────────────────────────────

/**
 * Desfecho do processamento de um evento de pagamento. Quem só quer "processar
 * e seguir" (os 4 endpoints de webhook) ignora o retorno; a conciliação pode
 * usá-lo pra saber o que aconteceu com cada cobrança.
 */
export type WebhookOutcome =
  | "no_id"               // payload sem nenhum identificador reconhecível
  | "not_found"           // nenhum pagamento deste provider/dono com esses ids
  | "ambiguous"           // os ids casam com MAIS DE UM pagamento — nada é aplicado
  | "duplicate"           // (pagamento, provider, status) já processado antes
  | "amount_mismatch"     // "pago", mas o valor não confere com o cobrado — não confirma
  | "confirmed"           // pending/expired → paid: venda confirmada agora
  | "already_paid"        // "pago" de novo para uma venda já paga — sem efeitos repetidos
  | "status_updated"      // pending → cancelled/expired
  | "invalid_transition"  // transição fora da máquina de estados — registrada e ignorada
  | "ignored";            // status sem transição (pending/unknown)

function describeMatches(matches: Payment[]): string {
  return matches.map((m) => `${m.id} (external_id=${m.externalId}, status=${m.status})`).join(", ");
}

export async function processWebhookEvent(event: NormalizedWebhookEvent, rawPayload: unknown, sourceIp?: string): Promise<WebhookOutcome> {
  // Candidatos = TODOS os ids plausíveis extraídos do payload (normalizeXWebhook).
  // Para buckpay/wiinpay isso é só [externalId] de sempre; para syncpay/nexuspag
  // pode ter vários, porque o campo que bate com payments.external_id varia
  // entre criação e webhook (ver gateway-clients.ts).
  const candidates = event.externalIdCandidates && event.externalIdCandidates.length > 0
    ? event.externalIdCandidates
    : (event.externalId ? [event.externalId] : []);
  const primaryId = event.externalId || candidates[0] || "";

  const baseLog = {
    provider: event.provider,
    event:    event.event,
    payload:  rawPayload,
    status:   event.status,
    amount:   event.amount,
    sourceIp,
  };

  // Um `return` mudo aqui era o pior lugar possível para não deixar rastro: é
  // exatamente o caso em que o payload do provedor não bate com o que o
  // normalizador espera, e o único jeito de descobrir a forma real é vendo o
  // corpo que ele mandou. Registra e só então desiste.
  if (candidates.length === 0) {
    await payRepo.logWebhook({
      ...baseLog,
      errorMessage: "sem identificador: o normalizador não achou nenhum id de transação neste payload",
    });
    return "no_id";
  }

  const matches = await payRepo.findAllByAnyExternalId(candidates, event.provider);

  // Nenhum candidato bateu: quase sempre significa que gravamos um id na
  // criação e o provedor devolve outro(s) no webhook. Lista os candidatos
  // tentados — é assim que confirmamos em produção se falta mais um campo.
  // NÃO marca como processado: se o webhook chegou antes do INSERT da cobrança
  // (createPix responde antes de payRepo.create gravar), a reentrega ainda
  // precisa conseguir confirmar a venda.
  if (matches.length === 0) {
    await payRepo.logWebhook({
      ...baseLog,
      externalId:   primaryId,
      errorMessage: `id "${primaryId}" não corresponde a nenhum pagamento de ${event.provider} (candidatos tentados: [${candidates.join(", ")}])`,
    });
    return "not_found";
  }

  // Mais de um pagamento casa com os ids deste payload (id colidindo entre
  // vendedores do mesmo provider, ou candidatos diferentes batendo em cobranças
  // diferentes). Confirmar "o primeiro" era confirmar a venda errada — registra
  // e não aplica nada; resolve-se na conciliação/manualmente.
  if (matches.length > 1) {
    await payRepo.logWebhook({
      ...baseLog,
      externalId:   primaryId,
      errorMessage: `ambíguo: os ids [${candidates.join(", ")}] casam com ${matches.length} pagamentos de ${event.provider} — nada aplicado: ${describeMatches(matches)}`,
    });
    return "ambiguous";
  }

  const payment = matches[0];

  // Idempotência — chave = o external_id GRAVADO na cobrança (canônico), não o
  // candidato #1 do payload: a ordem/forma dos candidatos pode variar entre
  // reentregas do mesmo evento (e o #1 nem sempre é o que bateu), o que furava
  // a deduplicação. Status faz parte da chave de propósito: uma venda gera
  // vários webhooks com o mesmo id ao longo do tempo (ex.: SyncPay manda
  // "pending" na criação e só depois "paid_out") — dedupar só por id travava a
  // venda no primeiro webhook. A garantia contra efeito duplicado é a
  // transição atômica abaixo; isto aqui só poupa trabalho e log repetido.
  const idemKey = payment.externalId ?? primaryId;
  if (await payRepo.isProcessed(idemKey, event.provider, event.status)) return "duplicate";

  const logResult = (processed: boolean, errorMessage?: string) => payRepo.logWebhook({
    ...baseLog,
    externalId:       idemKey,
    matchedPaymentId: payment.id,
    processed,
    ...(errorMessage ? { errorMessage } : {}),
  });

  let outcome: WebhookOutcome;

  if (event.status === "paid") {
    if (payment.status === "paid") {
      outcome = await handleAlreadyPaid(payment, event.provider, logResult);
    } else if (!canTransition(payment.status, "paid")) {
      await logResult(false, `transição inválida: ${payment.status} → paid — pagamento recebido para cobrança ${payment.status}; ignorado, conferir manualmente`);
      outcome = "invalid_transition";
    } else {
      // Confirma só se o valor pago bater com o cobrado. Divergência é falha
      // registrada, NÃO venda paga — e não marca como processado, pra
      // reentrega/conciliação poderem reavaliar.
      const check = checkPaidAmount(payment.amount, event.grossAmount ?? event.amount);
      if (!check.ok) {
        const netNote = event.amountIsNet
          ? " — o payload só trouxe o valor LÍQUIDO (sem valor bruto): provável taxa descontada, conferir no gateway antes de tratar como pagamento a menor"
          : "";
        await logResult(false, `não confirmado: ${check.reason}${netNote}`);
        return "amount_mismatch";
      }

      // Transição atômica pending/expired → paid (UPDATE ... WHERE status IN
      // (...) RETURNING). Dois webhooks concorrentes passam juntos pela
      // idempotência acima; só um recebe a linha de volta e dispara os efeitos.
      const paid = await payRepo.transitionStatus(payment.id, "paid", { finalAmount: event.amount });
      if (paid) {
        await logResult(true);
        await onPaymentConfirmed(paid, event);
        outcome = "confirmed";
      } else {
        // Perdeu a corrida: outra requisição mudou o status entre a leitura e o UPDATE.
        const current = await payRepo.findById(payment.id);
        if (current?.status === "paid") {
          outcome = await handleAlreadyPaid(current, event.provider, logResult);
        } else {
          await logResult(false, `transição inválida: status mudou para ${current?.status ?? "?"} antes de aplicar paid — ignorado`);
          outcome = "invalid_transition";
        }
      }
    }
  } else if (event.status === "cancelled" || event.status === "expired") {
    if (!canTransition(payment.status, event.status)) {
      // Ex.: estorno/expiração depois do pago. Antes rebaixava a venda paga.
      await logResult(false, `transição inválida: ${payment.status} → ${event.status} — ignorada`);
      outcome = "invalid_transition";
    } else if (await payRepo.transitionStatus(payment.id, event.status)) {
      await logResult(true);
      outcome = "status_updated";
    } else {
      await logResult(false, `transição inválida: status mudou antes de aplicar ${event.status} — ignorada`);
      outcome = "invalid_transition";
    }
  } else {
    // pending/unknown: nada a aplicar (webhook de criação, status desconhecido).
    await logResult(true);
    outcome = "ignored";
  }

  await payRepo.markProcessed(idemKey, event.provider, event.status);
  return outcome;
}

// "Pago" para uma venda que já está paga (webhook repetido com outra forma,
// concorrente que perdeu a corrida, conciliação). Nada de push/pixel de novo.
// Se a entrega nunca foi reivindicada (a confirmação anterior caiu entre a
// transição e o publish), republica: receita, comissão e evento são
// idempotentes e o subscriber do runner só entrega uma vez.
async function handleAlreadyPaid(
  payment: Payment,
  provider: Provider,
  logResult: (processed: boolean, errorMessage?: string) => Promise<void>,
): Promise<WebhookOutcome> {
  await logResult(true);
  if (!payment.deliveryClaimedAt) await applyIdempotentPaidEffects(payment, provider);
  return "already_paid";
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
