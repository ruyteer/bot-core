import { eq, and, inArray, gte, lte, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  payments, paymentGateways, bots, leads,
  paymentWebhookLogs, processedWebhooks,
} from "../../shared/schema/index.js";
import type { Payment, PaymentWithMeta, SimplifiedPaymentCtx } from "../domain/payment.entity.js";

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
    }).returning();
    return this.toPayment(row);
  }

  async findById(id: string): Promise<Payment | null> {
    const [row] = await db.select().from(payments).where(eq(payments.id, id));
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
  // gravado. Em vez de escolher um candidato e falhar, tentamos TODOS de uma
  // vez com IN — mais barato que um loop de findByExternalId e evita o bug de
  // "achei o webhook mas usei o campo errado" que nunca aprovava a venda.
  async findByAnyExternalId(candidates: string[], provider: string): Promise<Payment | null> {
    const ids = candidates.filter((c) => c && c.trim());
    if (ids.length === 0) return null;
    const [row] = await db.select().from(payments)
      .where(and(inArray(payments.externalId, ids), sql`${payments.gatewayId} IN (
        SELECT id FROM payment_gateways WHERE provider = ${provider}
      )`));
    return row ? this.toPayment(row) : null;
  }

  async markPaid(id: string, finalAmount?: number): Promise<void> {
    await db.update(payments).set({
      status:      "paid",
      paidAt:      new Date(),
      finalAmount: finalAmount ?? undefined,
      updatedAt:   new Date(),
    }).where(eq(payments.id, id));
  }

  async updateStatus(id: string, status: string): Promise<void> {
    await db.update(payments).set({ status, updatedAt: new Date() }).where(eq(payments.id, id));
  }

  async isProcessed(externalId: string, provider: string): Promise<boolean> {
    const [row] = await db.select({ externalId: processedWebhooks.externalId })
      .from(processedWebhooks)
      .where(and(eq(processedWebhooks.externalId, externalId), eq(processedWebhooks.provider, provider)));
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
