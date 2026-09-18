// Bug: POST /leads/:id/message com kind:"photo" repassava mediaUrl (data URL
// base64, gerada pela UI via FileReader.readAsDataURL) direto pro campo
// `photo` do sendPhoto via JSON — a Bot API não aceita data URL nesse campo
// (só file_id ou URL http/https), então enviar foto pro lead nunca funcionou.
// Corrige decodificando a data URL e enviando por multipart, igual ao que
// setChatPhoto/setMyProfilePhoto já fazem em telegram-profile.ts.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createBot, createLead } from "../../test/helpers/seed.js";
import { getTelegramCalls, forceTelegramError } from "../../test/helpers/fetch-mock.js";
import { leadMessages } from "../shared/schema/index.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { sendMessage } = await import("./leads.api.js");

const TINY_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString("base64");

async function botWithLead() {
  const bot = await createBot();
  authUserId = bot.userId;
  const leadId = await createLead(bot.id, 555n);
  return { bot, leadId };
}

async function lastMessageContent(leadId: string): Promise<Record<string, unknown>> {
  const db = await testDb();
  const rows = await db.select().from(leadMessages).where(eq(leadMessages.leadId, leadId));
  return rows[rows.length - 1]?.content as Record<string, unknown>;
}

describe("POST /leads/:id/message — foto via data URL", () => {
  it("data URL de imagem válida (jpeg) vira upload multipart, não JSON", async () => {
    const { leadId } = await botWithLead();
    const mediaUrl = `data:image/jpeg;base64,${TINY_JPEG_BASE64}`;

    const result = await sendMessage({ id: leadId, kind: "photo", mediaUrl });

    expect(result.ok).toBe(true);
    const calls = getTelegramCalls("sendPhoto");
    expect(calls.length).toBe(1);
    // multipart: o helper de mock marca arquivos como { file, size }, nunca a
    // data URL crua indo pro corpo JSON.
    expect(calls[0].body.photo).toMatchObject({ file: "photo.jpg" });
    expect(typeof calls[0].body.photo).not.toBe("string");
  });

  it("PNG e WEBP também são aceitos", async () => {
    const { leadId: leadPng } = await botWithLead();
    await expect(sendMessage({
      id: leadPng, kind: "photo", mediaUrl: `data:image/png;base64,${TINY_JPEG_BASE64}`,
    })).resolves.toEqual({ ok: true });
    expect(getTelegramCalls("sendPhoto")[0].body.photo).toMatchObject({ file: "photo.png" });

    const { leadId: leadWebp } = await botWithLead();
    await expect(sendMessage({
      id: leadWebp, kind: "photo", mediaUrl: `data:image/webp;base64,${TINY_JPEG_BASE64}`,
    })).resolves.toEqual({ ok: true });
    expect(getTelegramCalls("sendPhoto")[1].body.photo).toMatchObject({ file: "photo.webp" });
  });

  it("MIME não permitido (ex.: gif) é rejeitado antes de chamar o Telegram", async () => {
    const { leadId } = await botWithLead();
    await expect(sendMessage({
      id: leadId, kind: "photo", mediaUrl: `data:image/gif;base64,${TINY_JPEG_BASE64}`,
    })).rejects.toThrow();
    expect(getTelegramCalls("sendPhoto").length).toBe(0);
  });

  it("base64 inválido é rejeitado", async () => {
    const { leadId } = await botWithLead();
    await expect(sendMessage({
      id: leadId, kind: "photo", mediaUrl: "data:image/jpeg;base64,not-valid-base64!!!",
    })).rejects.toThrow();
    expect(getTelegramCalls("sendPhoto").length).toBe(0);
  });

  it("tamanho acima do limite (2 MiB decodificados) é rejeitado", async () => {
    const { leadId } = await botWithLead();
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64");
    await expect(sendMessage({
      id: leadId, kind: "photo", mediaUrl: `data:image/jpeg;base64,${big}`,
    })).rejects.toThrow();
    expect(getTelegramCalls("sendPhoto").length).toBe(0);
  });

  it("mediaUrl continua gravada em lead_messages.content igual a antes (UI lê content.mediaUrl)", async () => {
    const { leadId } = await botWithLead();
    const mediaUrl = `data:image/jpeg;base64,${TINY_JPEG_BASE64}`;

    await sendMessage({ id: leadId, kind: "photo", mediaUrl });

    const content = await lastMessageContent(leadId);
    expect(content.kind).toBe("photo");
    expect(content.mediaUrl).toBe(mediaUrl);
  });

  it("file_id/URL http(s) continuam indo pelo caminho antigo (callMedia, JSON)", async () => {
    const { leadId } = await botWithLead();
    const result = await sendMessage({ id: leadId, kind: "photo", mediaUrl: "https://cdn.example.com/foto.jpg" });

    expect(result.ok).toBe(true);
    const call = getTelegramCalls("sendPhoto")[0];
    expect(call.body.photo).toBe("https://cdn.example.com/foto.jpg");
  });

  it("texto continua funcionando normalmente", async () => {
    const { leadId } = await botWithLead();
    const result = await sendMessage({ id: leadId, kind: "text", text: "oi lead" });

    expect(result.ok).toBe(true);
    const calls = getTelegramCalls("sendMessage");
    expect(calls.length).toBe(1);
    expect(calls[0].body.text).toBe("oi lead");
    const content = await lastMessageContent(leadId);
    expect(content.text).toBe("oi lead");
  });

  it("erro real do Telegram no upload multipart ainda vira APIError.internal (não engole a falha)", async () => {
    const { leadId } = await botWithLead();
    forceTelegramError("sendPhoto", 400, "photo bytes vazios");
    await expect(sendMessage({
      id: leadId, kind: "photo", mediaUrl: `data:image/jpeg;base64,${TINY_JPEG_BASE64}`,
    })).rejects.toThrow(/photo bytes vazios/);
  });
});
