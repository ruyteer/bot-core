import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { processDueBroadcasts } from "./application/process-broadcasts.use-case.js";
import { testDb } from "../../test/helpers/db.js";
import { scheduledMessages, broadcastRuns, payments, leads } from "../shared/schema/index.js";
import { createBot, createLead, createGateway } from "../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls } from "../../test/helpers/fetch-mock.js";

async function seedMsg(botId: string, userId: string, over: Partial<typeof scheduledMessages.$inferInsert> = {}) {
  const db = await testDb();
  const [row] = await db.insert(scheduledMessages).values({
    userId, botId, botIds: [botId], message: "Oi {nome}!",
    broadcastType: "instant", filterType: "all", targetType: "leads", targetGroupIds: [],
    scheduledAt: new Date(Date.now() - 1000), status: "pending", ...over,
  }).returning();
  return row;
}

describe("processDueBroadcasts", () => {
  it("envia a mensagem aos leads, interpola {nome}, marca sent e cria broadcast_run", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5001n); // firstName "Lead"
    const msg = await seedMsg(bot.id, bot.userId);

    const n = await processDueBroadcasts();
    expect(n).toBe(1);
    expect(getSentMessages()).toContain("Oi Lead!");

    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("sent");
    expect(after.sentAt).toBeInstanceOf(Date);
    const runs = await db.select().from(broadcastRuns);
    expect(runs.length).toBe(1);
    expect(runs[0].sentCount).toBe(1);
    expect(runs[0].failedCount).toBe(0);
  });

  it("não reenvia um broadcast já enviado (idempotência via claim)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5002n);
    await seedMsg(bot.id, bot.userId);
    await processDueBroadcasts();
    const n2 = await processDueBroadcasts(); // nada pendente
    expect(n2).toBe(0);
    expect(getSentMessages().filter((m) => m === "Oi Lead!").length).toBe(1);
  });

  it("filterType 'buyers' só envia para quem comprou", async () => {
    const bot = await createBot();
    const gw = await createGateway({ userId: bot.userId });
    const buyer = await createLead(bot.id, 5003n);
    await createLead(bot.id, 5004n); // não comprador
    const db = await testDb();
    await db.insert(payments).values({ userId: bot.userId, botId: bot.id, leadId: buyer, gatewayId: gw, amount: 1000, status: "paid" });
    await seedMsg(bot.id, bot.userId, { filterType: "buyers", message: "promo" });

    await processDueBroadcasts();
    // só 1 envio (o comprador)
    expect(getTelegramCalls("sendMessage").length).toBe(1);
  });

  it("recorrência diária reagenda (status pending + scheduledAt futuro)", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5005n);
    const msg = await seedMsg(bot.id, bot.userId, {
      broadcastType: "recurring",
      recurrenceRule: { freq: "daily", time: "09:00", tz: "America/Sao_Paulo" } as unknown as Record<string, unknown>,
    });
    await processDueBroadcasts();
    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("pending");
    expect(after.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect(after.recurrenceCount).toBe(1);
  });

  it("recorrência com max 1 ocorrência → completed", async () => {
    const bot = await createBot();
    await createLead(bot.id, 5006n);
    const msg = await seedMsg(bot.id, bot.userId, {
      broadcastType: "recurring", recurrenceMaxOccurrences: 1,
      recurrenceRule: { freq: "daily", time: "09:00" } as unknown as Record<string, unknown>,
    });
    await processDueBroadcasts();
    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msg.id));
    expect(after.status).toBe("completed");
  });
});
