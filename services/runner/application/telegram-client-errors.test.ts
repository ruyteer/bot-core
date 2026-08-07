// Incidente 2026-08-07: rajada de delays estourou o rate limit do Telegram e o
// erro genérico "Telegram sendPhoto failed" (sem código) escondeu a causa,
// enquanto cada 429 matava o funil do lead (delay → failed permanente).
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { TelegramClient, TelegramApiError } from "./telegram.client.js";
import { createBot } from "../../../test/helpers/seed.js";
import { forceTelegramError, getTelegramCalls } from "../../../test/helpers/fetch-mock.js";
import { testDb } from "../../../test/helpers/db.js";
import { mediaCache } from "../../shared/schema/index.js";

describe("TelegramApiError — erro rico da API", () => {
  it("carrega error_code, description e retry_after do 429", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramError("sendMessage", 429);
    try {
      await tg.sendMessage({ chatId: "1", text: "oi" });
      expect.unreachable("deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramApiError);
      const e = err as TelegramApiError;
      expect(e.errorCode).toBe(429);
      expect(e.isRateLimit).toBe(true);
      expect(e.retryAfter).toBe(7);
      expect(e.message).toContain("429");
      expect(e.message).toContain("retry_after=7");
    }
  });

  it("erro sem código continua com a descrição na mensagem", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramError("sendMessage", 403);
    await expect(tg.sendMessage({ chatId: "1", text: "oi" }))
      .rejects.toThrow(/403.*forced error/);
  });

  it("429 com file_id em cache NÃO re-tenta pela URL (não dobra a carga)", async () => {
    const bot = await createBot();
    const db = await testDb();
    const tg = new TelegramClient("tok", bot.id);

    // Popula o cache com um envio bem-sucedido.
    await tg.sendPhoto({ chatId: "1", photo: "https://cdn/img.jpg" });
    expect((await db.select().from(mediaCache).where(eq(mediaCache.botId, bot.id))).length).toBe(1);

    // Agora o Telegram devolve 429: o client deve falhar com UMA chamada só.
    const before = getTelegramCalls("sendPhoto").length;
    forceTelegramError("sendPhoto", 429);
    await expect(tg.sendPhoto({ chatId: "1", photo: "https://cdn/img.jpg" }))
      .rejects.toThrow(/429/);
    expect(getTelegramCalls("sendPhoto").length).toBe(before + 1);

    // E o cache não foi invalidado (file_id continua válido — o problema é rate).
    expect((await db.select().from(mediaCache).where(eq(mediaCache.botId, bot.id))).length).toBe(1);
  });
});
