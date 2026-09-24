// Auditoria do backend (24/09): tracking_pixels não tinha unicidade por
// (bot_id, provider) — upsertPixel fazia select-então-insert/update sem lock,
// então duas chamadas concorrentes de PUT /bots/:id/pixels/:provider liam
// "não existe" e as duas inseriam, cadastrando o mesmo provider duas vezes no
// mesmo bot. Ver migration 0019 (índice único + dedup defensivo) e
// services/shared/schema/index.ts (trackingPixels).
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { trackingPixels } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { upsertPixel } = await import("./bots.api.js");

describe("tracking_pixels: unicidade por (bot_id, provider)", () => {
  it("upsert repetido pro mesmo provider ATUALIZA a linha em vez de duplicar", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    const first  = await upsertPixel({ id: bot.id, provider: "facebook", pixelId: "px_v1", accessToken: "tok1" });
    const second = await upsertPixel({ id: bot.id, provider: "facebook", pixelId: "px_v2" });

    expect(second.id).toBe(first.id);
    expect(second.pixelId).toBe("px_v2");

    const db = await testDb();
    const rows = await db.select().from(trackingPixels).where(eq(trackingPixels.botId, bot.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].pixelId).toBe("px_v2");
    // accessToken não foi reenviado no 2º upsert — mantém o valor salvo.
    expect(rows[0].accessToken).not.toBeNull();
  });

  it("upserts concorrentes pro mesmo (bot, provider) não criam duas linhas", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    await Promise.all([
      upsertPixel({ id: bot.id, provider: "tiktok", pixelId: "px_a" }),
      upsertPixel({ id: bot.id, provider: "tiktok", pixelId: "px_b" }),
    ]);

    const db = await testDb();
    const rows = await db.select().from(trackingPixels).where(eq(trackingPixels.botId, bot.id));
    expect(rows).toHaveLength(1);
    expect(["px_a", "px_b"]).toContain(rows[0].pixelId);
  });

  it("o mesmo provider em bots diferentes não colide", async () => {
    const botA = await createBot();
    const botB = await createBot({ userId: botA.userId });
    authUserId = botA.userId;

    await upsertPixel({ id: botA.id, provider: "kwai", pixelId: "px_bot_a" });
    await upsertPixel({ id: botB.id, provider: "kwai", pixelId: "px_bot_b" });

    const db = await testDb();
    const rows = await db.select().from(trackingPixels);
    expect(rows).toHaveLength(2);
  });
});
