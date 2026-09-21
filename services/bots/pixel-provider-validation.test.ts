// Furo: upsert/get/delete/test de pixel aceitavam qualquer string como
// `provider` — um valor inválido só ia quebrar mais tarde, na hora do
// dispatcher tentar montar o payload pro provedor certo. Agora é
// invalidArgument na entrada, pros providers suportados (facebook/tiktok/kwai).
import { describe, it, expect, vi } from "vitest";
import { testDb } from "../../test/helpers/db.js";
import { trackingPixels } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { upsertPixel, deletePixel, testPixel } = await import("./bots.api.js");

describe("provider inválido em endpoints de pixel", () => {
  it("upsertPixel rejeita provider desconhecido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    await expect(upsertPixel({ id: bot.id, provider: "google", pixelId: "px1" }))
      .rejects.toThrow(/provider inválido/);
  });

  it("deletePixel rejeita provider desconhecido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    await expect(deletePixel({ id: bot.id, provider: "" }))
      .rejects.toThrow(/provider inválido/);
  });

  it("testPixel rejeita provider desconhecido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    await expect(testPixel({ id: bot.id, provider: "adwords" }))
      .rejects.toThrow(/provider inválido/);
  });

  it("os três providers válidos continuam funcionando", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    for (const provider of ["facebook", "tiktok", "kwai"] as const) {
      const res = await upsertPixel({ id: bot.id, provider, pixelId: `px_${provider}` });
      expect(res.provider).toBe(provider);
    }
    const db = await testDb();
    expect((await db.select().from(trackingPixels)).length).toBe(3);
  });

  it("provider inválido não chega a tocar o banco (upsert não cria linha nenhuma)", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    await expect(upsertPixel({ id: bot.id, provider: "google", pixelId: "px1", accessToken: "tok" }))
      .rejects.toThrow();
    const db = await testDb();
    expect((await db.select().from(trackingPixels)).length).toBe(0);
  });
});
