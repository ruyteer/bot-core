import { eq, and, inArray, gte, lte, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  payments, paymentGateways, bots, leads,
  paymentWebhookLogs, processedWebhooks,
} from "../../shared/schema/index.js";
import type { Payment, PaymentWithMeta } from "../domain/payment.entity.js";

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
      paidAt:           row.paidAt,
      description:      row.description,
      createdAt:        row.createdAt,
      updatedAt:        row.updatedAt,
    };
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
    sourceIp?: string;
    matchedPaymentId?: string;
  }): Promise<void> {
    await db.insert(paymentWebhookLogs).values({
      provider:         data.provider,
      externalId:       data.externalId,
      event:            data.event,
      payload:          data.payload as Record<string, unknown>,
      status:           data.status,
      sourceIp:         data.sourceIp,
      matchedPaymentId: data.matchedPaymentId,
    });
  }
}
