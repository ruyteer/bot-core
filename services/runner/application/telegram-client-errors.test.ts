// Incidente 2026-08-07: rajada de delays estourou o rate limit do Telegram e o
// erro genérico "Telegram sendPhoto failed" (sem código) escondeu a causa,
// enquanto cada 429 matava o funil do lead (delay → failed permanente).
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { TelegramClient, TelegramApiError } from "./telegram.client.js";
import { createBot } from "../../../test/helpers/seed.js";
import { forceTelegramError, forceTelegramNetworkError, getTelegramCalls } from "../../../test/helpers/fetch-mock.js";
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

    // Agora o Telegram devolve 429 com retry_after grande (default do mock,
    // 7s) — grande demais pra o retry inline (limite de 2s), então o client
    // desiste na 1ª tentativa: UMA chamada só, sem cair pro fallback por URL.
    const before = getTelegramCalls("sendPhoto").length;
    forceTelegramError("sendPhoto", 429);
    await expect(tg.sendPhoto({ chatId: "1", photo: "https://cdn/img.jpg" }))
      .rejects.toThrow(/429/);
    expect(getTelegramCalls("sendPhoto").length).toBe(before + 1);

    // E o cache não foi invalidado (file_id continua válido — o problema é rate).
    expect((await db.select().from(mediaCache).where(eq(mediaCache.botId, bot.id))).length).toBe(1);
  });
});

// Item de auditoria: o TelegramClient não tinha nenhum retry/backoff — um 429
// ou uma falha 5xx/rede transitória derrubava a chamada na hora, mesmo quando
// tentar de novo (respeitando o retry_after) resolveria. Ver telegram.client.ts.
describe("TelegramClient — retry/backoff conservador", () => {
  it("429 com retry_after PEQUENO (<=2s) é retentado inline e a chamada acaba com sucesso", async () => {
    const tg = new TelegramClient("tok");
    // Só a 1ª chamada falha (times: 1) — a 2ª (o retry) tem sucesso.
    forceTelegramError("sendMessage", 429, undefined, { retryAfterSec: 1, times: 1 });
    const before = getTelegramCalls("sendMessage").length;
    await expect(tg.sendMessage({ chatId: "1", text: "oi" })).resolves.toBeUndefined();
    expect(getTelegramCalls("sendMessage").length).toBe(before + 2); // tentativa + 1 retry
  });

  it("429 com retry_after GRANDE não é retentado inline (propaga na 1ª tentativa)", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramError("sendMessage", 429, undefined, { retryAfterSec: 5 });
    const before = getTelegramCalls("sendMessage").length;
    await expect(tg.sendMessage({ chatId: "1", text: "oi" })).rejects.toThrow(/429/);
    expect(getTelegramCalls("sendMessage").length).toBe(before + 1); // nenhum retry
  });

  it("erro 5xx do Telegram é retentado com backoff e a chamada acaba com sucesso", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramError("sendMessage", 500, "Internal Server Error", { times: 1 });
    const before = getTelegramCalls("sendMessage").length;
    await expect(tg.sendMessage({ chatId: "1", text: "oi" })).resolves.toBeUndefined();
    expect(getTelegramCalls("sendMessage").length).toBe(before + 2);
  });

  it("5xx persistente esgota as tentativas e propaga o erro", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramError("sendMessage", 502, "Bad Gateway"); // sem `times` — sempre falha
    const before = getTelegramCalls("sendMessage").length;
    await expect(tg.sendMessage({ chatId: "1", text: "oi" })).rejects.toThrow(/502/);
    expect(getTelegramCalls("sendMessage").length).toBe(before + 3); // 1ª tentativa + 2 retries
  });

  it("erro definitivo (403, bot bloqueado) NUNCA é retentado — propaga na 1ª tentativa", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user");
    const before = getTelegramCalls("sendMessage").length;
    await expect(tg.sendMessage({ chatId: "1", text: "oi" })).rejects.toThrow(/403/);
    expect(getTelegramCalls("sendMessage").length).toBe(before + 1);
  });

  it("erro definitivo (401, token inválido) NUNCA é retentado — propaga na 1ª tentativa", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramError("sendMessage", 401, "Unauthorized");
    const before = getTelegramCalls("sendMessage").length;
    await expect(tg.sendMessage({ chatId: "1", text: "oi" })).rejects.toThrow(/401/);
    expect(getTelegramCalls("sendMessage").length).toBe(before + 1);
  });
});

// Achado de revisão do PR: erro de rede/timeout é AMBÍGUO — não dá pra saber
// se o Telegram processou a requisição antes da conexão cair. Retentar um
// método de ENVIO nesse caso pode duplicar a mensagem pro lead (ou, no caso
// de createChatInviteLink, criar um 2º link de uso único órfão). Por isso só
// métodos explicitamente marcados como idempotentes (leitura, ou uma ação sem
// efeito cumulativo) retentam erro de rede/timeout — ver `idempotent` em
// telegram.client.ts.
describe("TelegramClient — retry de rede/timeout só em métodos idempotentes", () => {
  it("timeout em sendMessage (não-idempotente) NÃO retenta — uma única chamada, erro propaga", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramNetworkError("sendMessage");
    const before = getTelegramCalls("sendMessage").length;
    await expect(tg.sendMessage({ chatId: "1", text: "oi" })).rejects.toThrow(/simulated network failure/);
    expect(getTelegramCalls("sendMessage").length).toBe(before + 1);
  });

  it("timeout em createChatInviteLink (criação, não-idempotente) NÃO retenta — evita link de convite duplicado", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramNetworkError("createChatInviteLink");
    const before = getTelegramCalls("createChatInviteLink").length;
    await expect(tg.createChatInviteLink("1")).rejects.toThrow(/simulated network failure/);
    expect(getTelegramCalls("createChatInviteLink").length).toBe(before + 1);
  });

  it("timeout em getChat (leitura, idempotente) É retentado e acaba com sucesso", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramNetworkError("getChat", 1); // só a 1ª chamada falha
    const before = getTelegramCalls("getChat").length;
    const chat = await tg.getChat("1");
    expect(chat).not.toBeNull();
    expect(getTelegramCalls("getChat").length).toBe(before + 2); // tentativa + 1 retry
  });

  it("timeout em deleteMessage (ação sem efeito cumulativo, idempotente) É retentado", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramNetworkError("deleteMessage", 1);
    const before = getTelegramCalls("deleteMessage").length;
    await tg.deleteMessage("1", 42); // não lança (best-effort), mas deve ter retentado por baixo
    expect(getTelegramCalls("deleteMessage").length).toBe(before + 2);
  });

  it("timeout em answerCallbackQuery (idempotente) É retentado", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramNetworkError("answerCallbackQuery", 1);
    const before = getTelegramCalls("answerCallbackQuery").length;
    await tg.answerCallbackQuery({ callbackQueryId: "cb1" });
    expect(getTelegramCalls("answerCallbackQuery").length).toBe(before + 2);
  });

  it("timeout persistente num método idempotente esgota as tentativas e propaga", async () => {
    const tg = new TelegramClient("tok");
    forceTelegramNetworkError("getChat"); // sem `times` — sempre falha
    const before = getTelegramCalls("getChat").length;
    const chat = await tg.getChat("1"); // getChat engole erro e devolve null
    expect(chat).toBeNull();
    expect(getTelegramCalls("getChat").length).toBe(before + 3); // 1ª tentativa + 2 retries
  });
});
