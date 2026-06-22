import { eq, and } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { paymentGateways } from "../../shared/schema/index.js";
import { encrypt, decrypt } from "../../shared/crypto.js";
import type { PaymentGateway, GatewaySafe, CreateGatewayInput, UpdateGatewayInput, Provider } from "../domain/gateway.entity.js";

export class GatewayDrizzleRepository {
  private toGateway(row: typeof paymentGateways.$inferSelect): PaymentGateway {
    return {
      id:           row.id,
      userId:       row.userId,
      provider:     row.provider as Provider,
      label:        row.label,
      clientId:     row.clientId,
      clientSecret: row.clientSecret,
      isActive:     row.isActive,
      createdAt:    row.createdAt,
      updatedAt:    row.updatedAt,
    };
  }

  async findByUserId(userId: string): Promise<GatewaySafe[]> {
    const rows = await db.select({
      id:       paymentGateways.id,
      provider: paymentGateways.provider,
      label:    paymentGateways.label,
      isActive: paymentGateways.isActive,
    }).from(paymentGateways).where(eq(paymentGateways.userId, userId));
    return rows.map((r) => ({ ...r, provider: r.provider as Provider }));
  }

  async findByIdOwned(id: string, userId: string): Promise<PaymentGateway | null> {
    const [row] = await db.select().from(paymentGateways)
      .where(and(eq(paymentGateways.id, id), eq(paymentGateways.userId, userId)));
    return row ? this.toGateway(row) : null;
  }

  async findById(id: string): Promise<PaymentGateway | null> {
    const [row] = await db.select().from(paymentGateways).where(eq(paymentGateways.id, id));
    return row ? this.toGateway(row) : null;
  }

  async create(input: CreateGatewayInput): Promise<GatewaySafe> {
    const [row] = await db.insert(paymentGateways).values({
      userId:       input.userId,
      provider:     input.provider,
      label:        input.label,
      clientId:     encrypt(input.clientId),
      clientSecret: encrypt(input.clientSecret),
      isActive:     true,
    }).returning({ id: paymentGateways.id, provider: paymentGateways.provider, label: paymentGateways.label, isActive: paymentGateways.isActive });
    return { ...row, provider: row.provider as Provider };
  }

  async update(id: string, userId: string, input: UpdateGatewayInput): Promise<GatewaySafe> {
    const [row] = await db.update(paymentGateways).set({
      ...(input.label      !== undefined && { label:        input.label }),
      ...(input.clientId   !== undefined && { clientId:     encrypt(input.clientId) }),
      ...(input.clientSecret !== undefined && { clientSecret: encrypt(input.clientSecret) }),
      updatedAt: new Date(),
    }).where(and(eq(paymentGateways.id, id), eq(paymentGateways.userId, userId)))
      .returning({ id: paymentGateways.id, provider: paymentGateways.provider, label: paymentGateways.label, isActive: paymentGateways.isActive });
    return { ...row, provider: row.provider as Provider };
  }

  async toggle(id: string, userId: string, isActive: boolean): Promise<void> {
    await db.update(paymentGateways).set({ isActive, updatedAt: new Date() })
      .where(and(eq(paymentGateways.id, id), eq(paymentGateways.userId, userId)));
  }

  async delete(id: string, userId: string): Promise<void> {
    await db.delete(paymentGateways)
      .where(and(eq(paymentGateways.id, id), eq(paymentGateways.userId, userId)));
  }

  // Decrypt credentials for use in API calls
  decryptCredentials(gw: PaymentGateway): { clientId: string; clientSecret: string } {
    return { clientId: decrypt(gw.clientId), clientSecret: decrypt(gw.clientSecret) };
  }
}
