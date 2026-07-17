import { eq, and, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { bots, leads, payments } from "../../shared/schema/index.js";
import { decrypt } from "../../shared/crypto.js";
import type { Bot, BotInternal, BotWithStats, CreateBotInput, UpdateBotInput } from "../domain/bot.entity.js";
import type { BotRepository } from "../domain/bot.repository.js";

function toPublic(row: typeof bots.$inferSelect): Bot {
  return {
    id:               row.id,
    userId:           row.userId,
    name:             row.name,
    telegramUsername: row.telegramUsername ?? null,
    isActive:         row.isActive,
    protectContent:   row.protectContent,
    defaultGatewayId: row.defaultGatewayId ?? null,
    createdAt:        row.createdAt,
    updatedAt:        row.updatedAt,
  };
}

export class BotDrizzleRepository implements BotRepository {
  async create(
    input: CreateBotInput & { webhookSecret: string; encryptedToken: string },
  ): Promise<Bot> {
    const [row] = await db
      .insert(bots)
      .values({
        userId:        input.userId,
        name:          input.name,
        telegramToken: input.encryptedToken,
        webhookSecret: input.webhookSecret,
      })
      .returning();
    return toPublic(row);
  }

  async findByUserId(userId: string): Promise<BotWithStats[]> {
    const rows = await db
      .select({
        id:               bots.id,
        userId:           bots.userId,
        name:             bots.name,
        telegramUsername: bots.telegramUsername,
        isActive:         bots.isActive,
        protectContent:   bots.protectContent,
        defaultGatewayId: bots.defaultGatewayId,
        createdAt:        bots.createdAt,
        updatedAt:        bots.updatedAt,
        leadsCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${leads} WHERE ${leads.botId} = ${bots.id}
        )`,
        salesCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${payments}
          WHERE ${payments.botId} = ${bots.id} AND ${payments.status} = 'paid'
        )`,
      })
      .from(bots)
      .where(eq(bots.userId, userId))
      .orderBy(bots.createdAt);

    return rows.map((r) => ({
      id:               r.id,
      userId:           r.userId,
      name:             r.name,
      telegramUsername: r.telegramUsername ?? null,
      isActive:         r.isActive,
      protectContent:   r.protectContent,
      defaultGatewayId: r.defaultGatewayId ?? null,
      createdAt:        r.createdAt,
      updatedAt:        r.updatedAt,
      leadsCount:       r.leadsCount ?? 0,
      salesCount:       r.salesCount ?? 0,
    }));
  }

  async findById(id: string): Promise<Bot | null> {
    const [row] = await db.select().from(bots).where(eq(bots.id, id)).limit(1);
    return row ? toPublic(row) : null;
  }

  async findInternalById(id: string): Promise<BotInternal | null> {
    const [row] = await db.select().from(bots).where(eq(bots.id, id)).limit(1);
    if (!row) return null;
    return {
      ...toPublic(row),
      telegramToken: decrypt(row.telegramToken),
      webhookSecret: row.webhookSecret,
    };
  }

  async update(
    id: string,
    userId: string,
    input: UpdateBotInput & { telegramUsername?: string },
  ): Promise<Bot> {
    const set: Partial<typeof bots.$inferInsert> = { updatedAt: new Date() };
    if (input.name           !== undefined) set.name           = input.name;
    if (input.isActive       !== undefined) set.isActive       = input.isActive;
    if (input.protectContent !== undefined) set.protectContent = input.protectContent;
    if (input.telegramUsername !== undefined) set.telegramUsername = input.telegramUsername;
    if (input.defaultGatewayId !== undefined) set.defaultGatewayId = input.defaultGatewayId;
    if (input.telegramToken    !== undefined) set.telegramToken    = input.telegramToken;

    const [row] = await db
      .update(bots)
      .set(set)
      .where(and(eq(bots.id, id), eq(bots.userId, userId)))
      .returning();
    return toPublic(row);
  }

  async delete(id: string, userId: string): Promise<void> {
    await db.delete(bots).where(and(eq(bots.id, id), eq(bots.userId, userId)));
  }

  async belongsToUser(id: string, userId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, userId)))
      .limit(1);
    return !!row;
  }
}
