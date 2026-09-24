// Poda de `processed_telegram_updates` (dedupe de update do Telegram, Achado 1
// da auditoria do runner do funil de fluxo): a tabela ganha uma linha por
// update de CADA bot pra sempre — sem poda periódica ela cresce sem limite.
// O Telegram não reentrega um update depois de ~48h, então é seguro apagar o
// que passou desse prazo. A poda roda em lotes (não um DELETE só) pra não
// travar a tabela numa poda grande.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createBot } from "../../test/helpers/seed.js";
import { processedTelegramUpdates } from "../shared/schema/index.js";
import { cleanupProcessedTelegramUpdates } from "./runner.js";

describe("cleanupProcessedTelegramUpdates", () => {
  it("apaga só registros com mais de 48h, mantém os recentes", async () => {
    const bot = await createBot();
    const db = await testDb();
    const old = new Date(Date.now() - 50 * 3600 * 1000);   // 50h atrás
    const recent = new Date(Date.now() - 10 * 3600 * 1000); // 10h atrás

    await db.insert(processedTelegramUpdates).values([
      { botId: bot.id, updateId: 1, createdAt: old },
      { botId: bot.id, updateId: 2, createdAt: old },
      { botId: bot.id, updateId: 3, createdAt: recent },
    ]);

    const deleted = await cleanupProcessedTelegramUpdates();
    expect(deleted).toBe(2);

    const remaining = await db.select().from(processedTelegramUpdates).where(eq(processedTelegramUpdates.botId, bot.id));
    expect(remaining.map((r) => r.updateId).sort()).toEqual([3]);
  });

  it("poda em lotes: mais registros antigos do que o tamanho de um lote são todos apagados", async () => {
    const bot = await createBot();
    const db = await testDb();
    const old = new Date(Date.now() - 72 * 3600 * 1000);

    // Acima do tamanho do lote (5000) pra forçar mais de uma volta do loop.
    const total = 5200;
    const rows = Array.from({ length: total }, (_, i) => ({
      botId: bot.id, updateId: i + 1, createdAt: old,
    }));
    await db.insert(processedTelegramUpdates).values(rows);

    const deleted = await cleanupProcessedTelegramUpdates();
    expect(deleted).toBe(total);

    const remaining = await db.select().from(processedTelegramUpdates).where(eq(processedTelegramUpdates.botId, bot.id));
    expect(remaining).toHaveLength(0);
  }, 20_000);

  it("nada pra podar devolve 0 sem erro", async () => {
    const deleted = await cleanupProcessedTelegramUpdates();
    expect(deleted).toBe(0);
  });
});
