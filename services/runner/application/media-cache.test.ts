import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { TelegramClient } from "./telegram.client.js";
import { testDb } from "../../../test/helpers/db.js";
import { mediaCache } from "../../shared/schema/index.js";
import { createBot } from "../../../test/helpers/seed.js";
import { getTelegramCalls } from "../../../test/helpers/fetch-mock.js";

const URL_IMG = "https://cdn.exemplo.com/banner.png";
const hashOf = (kind: string, url: string) => createHash("sha256").update(`${kind}:${url}`).digest("hex");

describe("TelegramClient — cache de file_id de mídia", () => {
  it("1º envio vai por URL e grava o file_id; 2º envio vai por file_id", async () => {
    const bot = await createBot();
    const tg = new TelegramClient("tok", bot.id);

    await tg.sendPhoto({ chatId: "1", photo: URL_IMG });
    let calls = getTelegramCalls("sendPhoto");
    expect(calls[0].body.photo).toBe(URL_IMG);

    const db = await testDb();
    const rows = await db.select().from(mediaCache).where(eq(mediaCache.botId, bot.id));
    expect(rows.length).toBe(1);
    expect(rows[0].urlHash).toBe(hashOf("photo", URL_IMG));
    expect(rows[0].telegramFileId).toMatch(/^cached_photo_/);

    await tg.sendPhoto({ chatId: "1", photo: URL_IMG });
    calls = getTelegramCalls("sendPhoto");
    expect(calls[1].body.photo).toBe(rows[0].telegramFileId); // 2º envio usa o cache
  });

  it("file_id inválido → invalida o cache e reenvia por URL", async () => {
    const bot = await createBot();
    const db = await testDb();
    await db.insert(mediaCache).values({
      botId: bot.id, urlHash: hashOf("photo", URL_IMG), telegramFileId: "file_id_podre", mediaType: "photo",
    });

    const tg = new TelegramClient("tok", bot.id);
    let first = true;
    // 1ª chamada (file_id) falha; 2ª (URL) passa
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("sendPhoto") && first) {
        first = false;
        return new Response(JSON.stringify({ ok: false, description: "wrong file identifier" }), { status: 400 });
      }
      return origFetch(input, init);
    }) as typeof globalThis.fetch;
    try {
      await tg.sendPhoto({ chatId: "1", photo: URL_IMG });
    } finally {
      globalThis.fetch = origFetch;
    }

    const rows = await db.select().from(mediaCache).where(eq(mediaCache.botId, bot.id));
    expect(rows.length).toBe(1);
    expect(rows[0].telegramFileId).not.toBe("file_id_podre"); // renovado pelo reenvio via URL
  });

  it("URL de QR dinâmico (qrserver) não entra no cache", async () => {
    const bot = await createBot();
    const tg = new TelegramClient("tok", bot.id);
    await tg.sendPhoto({ chatId: "1", photo: "https://api.qrserver.com/v1/create-qr-code/?data=abc" });
    const db = await testDb();
    const rows = await db.select().from(mediaCache).where(eq(mediaCache.botId, bot.id));
    expect(rows.length).toBe(0);
  });

  it("álbum: itens novos gravam file_id e reenvio usa o cache", async () => {
    const bot = await createBot();
    const tg = new TelegramClient("tok", bot.id);
    const items = [
      { type: "photo" as const, media: "https://cdn.exemplo.com/a.png" },
      { type: "video" as const, media: "https://cdn.exemplo.com/b.mp4" },
    ];
    await tg.sendMediaGroup("1", items);
    const db = await testDb();
    const rows = await db.select().from(mediaCache).where(eq(mediaCache.botId, bot.id));
    expect(rows.length).toBe(2);

    await tg.sendMediaGroup("1", items);
    const calls = getTelegramCalls("sendMediaGroup");
    const media2 = calls[1].body.media as Array<{ media: string }>;
    expect(media2[0].media).toMatch(/^cached_photo_/);
    expect(media2[1].media).toMatch(/^cached_video_/);
  });

  it("sem botId (compat) → envia por URL e não cacheia", async () => {
    await createBot();
    const tg = new TelegramClient("tok");
    await tg.sendPhoto({ chatId: "1", photo: URL_IMG });
    const calls = getTelegramCalls("sendPhoto");
    expect(calls[0].body.photo).toBe(URL_IMG);
  });
});
