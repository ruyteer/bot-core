import { eq, and, asc, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import { db } from "../../shared/database.js";
import { paymentGateways, botPaymentGateways, bots, payments } from "../../shared/schema/index.js";
import { encrypt, decrypt } from "../../shared/crypto.js";
import type { PaymentGateway, GatewaySafe, CreateGatewayInput, UpdateGatewayInput, Provider } from "../domain/gateway.entity.js";

// SQLSTATE de violação de foreign key (Postgres e PGlite usam o mesmo código).
const FOREIGN_KEY_VIOLATION = "23503";

function isForeignKeyViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === FOREIGN_KEY_VIOLATION;
}

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

  // Cadeia de gateways do bot, na ordem configurada pelo usuário. Quem gera o PIX
  // tenta o primeiro e cai para o próximo se falhar (ver createPixWithFallback).
  // Só entram gateways ATIVOS e do dono do bot — um gateway desativado no painel
  // (ou de outro usuário) nunca é usado, mesmo que ainda esteja na ordem.
  // Sem ordem configurada, o fallback é "todos os ativos do usuário", para o bot
  // não ficar sem pagamento por falta de configuração.
  async findChainForBot(opts: { userId: string; botId: string }): Promise<PaymentGateway[]> {
    const ordered = await db.select({ gw: paymentGateways })
      .from(botPaymentGateways)
      .innerJoin(paymentGateways, eq(paymentGateways.id, botPaymentGateways.gatewayId))
      .where(and(
        eq(botPaymentGateways.botId, opts.botId),
        eq(paymentGateways.userId, opts.userId),
        eq(paymentGateways.isActive, true),
      ))
      .orderBy(asc(botPaymentGateways.position));

    if (ordered.length > 0) return ordered.map((r) => this.toGateway(r.gw));

    const rows = await db.select().from(paymentGateways)
      .where(and(eq(paymentGateways.userId, opts.userId), eq(paymentGateways.isActive, true)))
      .orderBy(asc(paymentGateways.createdAt));
    return rows.map((r) => this.toGateway(r));
  }

  // Ordem configurada do bot (inclui inativos, para a UI mostrar o estado real).
  async listChain(botId: string, userId: string): Promise<Array<GatewaySafe & { position: number }>> {
    const rows = await db.select({
      id:       paymentGateways.id,
      provider: paymentGateways.provider,
      label:    paymentGateways.label,
      isActive: paymentGateways.isActive,
      position: botPaymentGateways.position,
    })
      .from(botPaymentGateways)
      .innerJoin(paymentGateways, eq(paymentGateways.id, botPaymentGateways.gatewayId))
      .where(and(eq(botPaymentGateways.botId, botId), eq(paymentGateways.userId, userId)))
      .orderBy(asc(botPaymentGateways.position));
    return rows.map((r) => ({ ...r, provider: r.provider as Provider }));
  }

  // Substitui a ordem inteira do bot. Ignora ids que não sejam do usuário.
  // Retorna false se o bot não for do usuário (não mexe em nada).
  async setChain(botId: string, userId: string, gatewayIds: string[]): Promise<boolean> {
    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId))).limit(1);
    if (!bot) return false;

    const owned = await db.select({ id: paymentGateways.id }).from(paymentGateways)
      .where(eq(paymentGateways.userId, userId));
    const ownedIds = new Set(owned.map((o) => o.id));
    const clean = gatewayIds.filter((id, i) => ownedIds.has(id) && gatewayIds.indexOf(id) === i);

    await db.transaction(async (tx) => {
      await tx.delete(botPaymentGateways).where(eq(botPaymentGateways.botId, botId));
      if (clean.length > 0) {
        await tx.insert(botPaymentGateways)
          .values(clean.map((gatewayId, position) => ({ botId, gatewayId, position })));
      }
    });
    return true;
  }

  async create(input: CreateGatewayInput): Promise<GatewaySafe> {
    const [row] = await db.insert(paymentGateways).values({
      userId:       input.userId,
      provider:     input.provider,
      label:        input.label,
      clientId:     encrypt(input.clientId),
      // Coluna é NOT NULL; provedores sem secret continuam gravando "" (mesmo
      // comportamento de sempre quando o client manda string vazia).
      clientSecret: encrypt(input.clientSecret ?? ""),
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
    // Checagem prévia: dá o erro tipado direto na maioria dos casos, sem
    // depender de estourar a FK. `payments.gateway_id` não tem onDelete —
    // apagar um gateway com pagamentos vinculados sem isto estourava violação
    // de chave estrangeira crua (500) direto do driver.
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(payments)
      .where(eq(payments.gatewayId, id));
    if (count > 0) {
      throw APIError.failedPrecondition("há pagamentos vinculados a este gateway — não é possível excluir");
    }

    // Rede de segurança para a corrida entre a checagem acima e este delete
    // (ex.: um PIX sendo gerado nesse meio-tempo): se ainda assim bater na FK,
    // vira o mesmo erro tipado em vez de propagar o erro cru do driver.
    try {
      await db.delete(paymentGateways)
        .where(and(eq(paymentGateways.id, id), eq(paymentGateways.userId, userId)));
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw APIError.failedPrecondition("há pagamentos vinculados a este gateway — não é possível excluir");
      }
      throw err;
    }
  }

  // Decrypt credentials for use in API calls
  decryptCredentials(gw: PaymentGateway): { clientId: string; clientSecret: string } {
    return { clientId: decrypt(gw.clientId), clientSecret: decrypt(gw.clientSecret) };
  }
}
