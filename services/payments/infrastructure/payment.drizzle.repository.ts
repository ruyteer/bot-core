import { eq, and, or, asc, inArray, isNull, gte, lt, lte, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  payments, paymentGateways, bots, leads,
  paymentWebhookLogs, processedWebhooks,
} from "../../shared/schema/index.js";
import type { Payment, PaymentWithMeta, PaymentSplitSnapshot, SimplifiedPaymentCtx } from "../domain/payment.entity.js";
import { allowedSourcesFor, type PaymentStatus } from "../domain/payment-status.js";

/**
 * Valores aceitos em `payments.sale_type`. São EXATAMENTE os literais que o
 * painel espera (`ui/src/components/SalesByTypeTiles.tsx` e
 * `ui/src/pages/MyVendas.tsx`); qualquer outra string cai em "unknown" lá e
 * some dos cards. Null = venda antiga (o front trata como "offer").
 */
export type SaleType = "offer" | "order_bump" | "upsell" | "downsell" | "remarketing";

export class PaymentDrizzleRepository {
  private toPayment(row: typeof payments.$inferSelect): Payment {
    return {
      id:               row.id,
      userId:           row.userId,
      botId:            row.botId,
      leadId:           row.leadId,
      gatewayId:        row.gatewayId,
      offerId:          row.offerId,
      offerName:        row.offerName,
      offerExternalRef: row.offerExternalRef,
      amount:           row.amount,
      finalAmount:      row.finalAmount,
      status:           row.status,
      saleType:         row.saleType,
      externalId:       row.externalId,
      pixCode:          row.pixCode,
      endToEnd:         row.endToEnd,
      paidAt:           row.paidAt,
      description:      row.description,
      funnelId:         row.funnelId,
      progressId:       row.progressId,
      nodeId:           row.nodeId,
      paidHandle:       row.paidHandle,
      simplifiedCtx:    (row.simplifiedCtx as SimplifiedPaymentCtx | null) ?? null,
      splitSnapshot:     (row.splitSnapshot as PaymentSplitSnapshot | null) ?? null,
      deliveryClaimedAt: row.deliveryClaimedAt ?? null,
      deliveredAt:       row.deliveredAt ?? null,
      createdAt:        row.createdAt,
      updatedAt:        row.updatedAt,
    };
  }

  async create(data: {
    userId:           string;
    botId:            string;
    leadId?:          string | null;
    gatewayId:        string;
    offerId?:         string | null;
    offerName?:       string | null;
    offerExternalRef?: string | null;
    amount:           number;
    status?:          string;
    saleType?:        SaleType | null;
    externalId?:      string | null;
    pixCode?:         string | null;
    description?:     string | null;
    funnelId?:        string | null;
    progressId?:      string | null;
    nodeId?:          string | null;
    paidHandle?:      string | null;
    simplifiedCtx?:   SimplifiedPaymentCtx | null;
    /** Split aplicado no gateway ao gerar o PIX (createPixWithFallback → splitSnapshot). */
    splitSnapshot?:   PaymentSplitSnapshot | null;
  }): Promise<Payment> {
    const [row] = await db.insert(payments).values({
      userId:           data.userId,
      botId:            data.botId,
      leadId:           data.leadId,
      gatewayId:        data.gatewayId,
      offerId:          data.offerId,
      offerName:        data.offerName,
      offerExternalRef: data.offerExternalRef,
      amount:           data.amount,
      status:           data.status ?? "pending",
      saleType:         data.saleType ?? null,
      externalId:       data.externalId,
      pixCode:          data.pixCode,
      description:      data.description,
      funnelId:         data.funnelId,
      progressId:       data.progressId,
      nodeId:           data.nodeId,
      paidHandle:       data.paidHandle,
      simplifiedCtx:    data.simplifiedCtx ?? null,
      splitSnapshot:    data.splitSnapshot ?? null,
    }).returning();
    return this.toPayment(row);
  }

  async findById(id: string): Promise<Payment | null> {
    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    return row ? this.toPayment(row) : null;
  }

  // Pagamento PENDENTE já gerado pra esta oferta deste nó/lead — usado pelo
  // runner (execute-flow-step.use-case.ts → handleOfferPurchase) pra NÃO reemitir
  // PIX quando o mesmo botão de compra é clicado mais de uma vez antes do
  // primeiro ser pago (duplo-toque, ou um teclado antigo resolvido por escopo
  // reverso e tocado de novo). Some da busca assim que o webhook confirma
  // (transitionStatus → "paid") ou cancela/expira (transitionStatus) o pagamento.
  async findPendingForOffer(leadId: string, nodeId: string, paidHandle: string): Promise<Payment | null> {
    const [row] = await db.select().from(payments)
      .where(and(
        eq(payments.leadId, leadId),
        eq(payments.nodeId, nodeId),
        eq(payments.paidHandle, paidHandle),
        eq(payments.status, "pending"),
      ))
      .orderBy(sql`${payments.createdAt} DESC`)
      .limit(1);
    return row ? this.toPayment(row) : null;
  }

  // Pagamento PENDENTE já gerado pra este lead+refKey (oferta+bumps+valor) do
  // funil SIMPLIFICADO — usado por generatePix (execute-simplified-funnel.use-case.ts)
  // pra NÃO reemitir PIX quando o mesmo plano/upsell/downsell é clicado mais de
  // uma vez antes do primeiro ser pago. refKey já muda se os bumps escolhidos
  // mudarem, então nunca reaproveita PIX de uma combinação diferente. Some da
  // busca assim que o webhook confirma (markPaid) ou cancela/expira (updateStatus)
  // o pagamento. Mesmo papel de findPendingForOffer, mas pela chave do
  // simplificado (offer_external_ref) em vez de (node_id, paid_handle) do flow.
  async findPendingByOfferRef(leadId: string, offerExternalRef: string): Promise<Payment | null> {
    const [row] = await db.select().from(payments)
      .where(and(
        eq(payments.leadId, leadId),
        eq(payments.offerExternalRef, offerExternalRef),
        eq(payments.status, "pending"),
      ))
      .orderBy(sql`${payments.createdAt} DESC`)
      .limit(1);
    return row ? this.toPayment(row) : null;
  }

  async findByBotIds(botIds: string[], startDate?: Date, endDate?: Date): Promise<PaymentWithMeta[]> {
    if (botIds.length === 0) return [];

    const conditions = [inArray(payments.botId, botIds)];
    if (startDate) conditions.push(gte(payments.createdAt, startDate));
    if (endDate)   conditions.push(lte(payments.createdAt, endDate));

    const rows = await db
      .select({
        payment:      payments,
        botName:      bots.name,
        botUsername:  bots.telegramUsername,
        leadFirst:    leads.firstName,
        leadLast:     leads.lastName,
        leadUsername: leads.telegramUsername,
        leadChatId:   leads.telegramChatId,
        provider:     paymentGateways.provider,
        gwLabel:      paymentGateways.label,
      })
      .from(payments)
      .leftJoin(bots, eq(payments.botId, bots.id))
      .leftJoin(leads, eq(payments.leadId, leads.id))
      .leftJoin(paymentGateways, eq(payments.gatewayId, paymentGateways.id))
      .where(and(...conditions))
      .orderBy(sql`${payments.createdAt} DESC`);

    return rows.map((r) => ({
      ...this.toPayment(r.payment),
      botName:      r.botName ?? null,
      botUsername:  r.botUsername ?? null,
      leadName:     [r.leadFirst, r.leadLast].filter(Boolean).join(" ") || null,
      leadUsername: r.leadUsername ?? null,
      leadChatId:   r.leadChatId ? r.leadChatId.toString() : null,
      provider:     r.provider ?? null,
      gatewayLabel: r.gwLabel ?? null,
    }));
  }

  async getUserBotIds(userId: string): Promise<string[]> {
    const rows = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
    return rows.map((r) => r.id);
  }

  async findByExternalId(externalId: string, provider: string): Promise<Payment | null> {
    const [row] = await db.select().from(payments)
      .where(and(eq(payments.externalId, externalId), sql`${payments.gatewayId} IN (
        SELECT id FROM payment_gateways WHERE provider = ${provider}
      )`));
    return row ? this.toPayment(row) : null;
  }

  // Alguns gateways (syncpay/nexuspag) não usam de forma confiável o mesmo
  // campo de id entre a criação do PIX (o que gravamos em payments.external_id)
  // e o webhook de confirmação — o payload chega com vários candidatos
  // plausíveis (ver application/gateway-clients.ts normalizeXWebhook) e só um
  // deles (às vezes nenhum, às vezes o "errado" primeiro) bate com o que foi
  // gravado. Tentamos TODOS de uma vez com IN.
  //
  // Devolve TODOS os pagamentos que casam, não "o primeiro": antes era um
  // `[row]` sem ORDER BY — se um id colidisse entre dois pagamentos (dois
  // vendedores no mesmo provider, ou candidatos diferentes do mesmo payload
  // batendo em cobranças diferentes), confirmava um arbitrário. Quem chama
  // (processWebhookEvent) trata mais de um resultado como ambíguo e não
  // confirma nada. Escopo: o gateway da cobrança tem que ser do provider que
  // mandou o webhook E do MESMO dono do pagamento (findChainForBot só usa
  // gateways do dono do bot — um descasamento aqui é dado inconsistente, não
  // venda legítima). Status fica de fora de propósito: a máquina de estados
  // (transitionStatus) é quem decide o que fazer com um pagamento já pago/
  // cancelado, e precisa enxergá-lo pra registrar a transição inválida.
  async findAllByAnyExternalId(candidates: string[], provider: string): Promise<Payment[]> {
    const ids = [...new Set(candidates.map((c) => (c ?? "").trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    const rows = await db.select({ payment: payments })
      .from(payments)
      .innerJoin(paymentGateways, eq(paymentGateways.id, payments.gatewayId))
      .where(and(
        inArray(payments.externalId, ids),
        eq(paymentGateways.provider, provider),
        eq(paymentGateways.userId, payments.userId),
      ))
      .orderBy(asc(payments.createdAt), asc(payments.id))
      .limit(10);
    return rows.map((r) => this.toPayment(r.payment));
  }

  /**
   * Transição de status ATÔMICA, validada pela máquina de estados
   * (domain/payment-status.ts): `UPDATE ... WHERE status IN (<origens válidas>)
   * RETURNING`. Devolve o pagamento atualizado, ou null se a transição não
   * aconteceu (status atual não é uma origem válida — já pago, já cancelado —
   * ou outra requisição concorrente chegou antes). Só quem recebe o pagamento
   * de volta dispara os efeitos da transição (entrega, receita, push...).
   */
  async transitionStatus(
    id: string,
    to: PaymentStatus,
    opts: { finalAmount?: number | null } = {},
  ): Promise<Payment | null> {
    const from = allowedSourcesFor(to);
    if (from.length === 0) return null;
    const now = new Date();
    const [row] = await db.update(payments).set({
      status:    to,
      updatedAt: now,
      ...(to === "paid" ? { paidAt: now, finalAmount: opts.finalAmount ?? undefined } : {}),
    })
      .where(and(eq(payments.id, id), inArray(payments.status, [...from])))
      .returning();
    return row ? this.toPayment(row) : null;
  }

  /**
   * Reivindica a entrega de um pagamento pago — o tópico paymentPaid é
   * at-least-once e a mesma mensagem pode chegar mais de uma vez (ou ser
   * republicada pela recuperação do webhook). Só UMA chamada recebe o
   * pagamento de volta; as demais recebem null e não entregam.
   *
   * Uma reivindicação sem `delivered_at` há mais de `staleAfterMs` (processo
   * morreu no meio da entrega) pode ser retomada — mesmo espírito da
   * recuperação de órfãos dos scheduled_delays.
   */
  async claimDelivery(id: string, staleAfterMs = 10 * 60_000): Promise<Payment | null> {
    const staleBefore = new Date(Date.now() - staleAfterMs);
    const [row] = await db.update(payments).set({ deliveryClaimedAt: new Date() })
      .where(and(
        eq(payments.id, id),
        eq(payments.status, "paid"),
        isNull(payments.deliveredAt),
        or(isNull(payments.deliveryClaimedAt), lt(payments.deliveryClaimedAt, staleBefore)),
      ))
      .returning();
    return row ? this.toPayment(row) : null;
  }

  async markDelivered(id: string): Promise<void> {
    await db.update(payments).set({ deliveredAt: new Date() }).where(eq(payments.id, id));
  }

  // Nenhuma escrita de status fora da máquina de estados: o antigo
  // updateStatus(id, qualquer) incondicional foi removido (rebaixava venda paga
  // para "expired" na corrida com o webhook) e markPaid passa pela transição.
  async markPaid(id: string, finalAmount?: number): Promise<Payment | null> {
    return this.transitionStatus(id, "paid", { finalAmount });
  }

  async isProcessed(externalId: string, provider: string, status: string): Promise<boolean> {
    const [row] = await db.select({ externalId: processedWebhooks.externalId })
      .from(processedWebhooks)
      .where(and(
        eq(processedWebhooks.externalId, externalId),
        eq(processedWebhooks.provider, provider),
        eq(processedWebhooks.status, status),
      ));
    return !!row;
  }

  async markProcessed(externalId: string, provider: string, status: string): Promise<void> {
    await db.insert(processedWebhooks).values({ externalId, provider, status })
      .onConflictDoNothing();
  }

  async logWebhook(data: {
    provider:  string;
    externalId?: string;
    event?:    string;
    payload:   unknown;
    status?:   string;
    /** Valor em centavos extraído do payload — pro card "Valor" no admin. */
    amount?:   number | null;
    sourceIp?: string;
    matchedPaymentId?: string;
    /** true = webhook entendido e tratado (achou o pagamento, sem erro). */
    processed?: boolean;
    /** Por que este webhook não virou confirmação de venda. */
    errorMessage?: string;
  }): Promise<void> {
    await db.insert(paymentWebhookLogs).values({
      provider:         data.provider,
      externalId:       data.externalId,
      event:            data.event,
      payload:          data.payload as Record<string, unknown>,
      status:           data.status,
      amount:           data.amount ?? undefined,
      sourceIp:         data.sourceIp,
      matchedPaymentId: data.matchedPaymentId,
      processed:        data.processed ?? false,
      errorMessage:     data.errorMessage,
    });
  }
}
