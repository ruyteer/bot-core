import { api, APIError } from "encore.dev/api";
import { eq } from "drizzle-orm";
import { db } from "../shared/database.js";
import { bots } from "../shared/schema/index.js";
import { decrypt } from "../shared/crypto.js";
import { telegramUpdateReceived, type TelegramUpdate } from "../shared/events/index.js";

// Recebe updates do Telegram para um bot específico
export const handle = api.raw(
  { expose: true, method: "POST", path: "/webhook/:botId" },
  async (req, resp) => {
    const botId = (req.url ?? "").split("/webhook/")[1]?.split("?")[0] ?? "";

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot || !bot.isActive) {
      resp.writeHead(404);
      resp.end();
      return;
    }

    // Verifica o secret do Telegram (HMAC)
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    if (secret !== bot.webhookSecret) {
      resp.writeHead(401);
      resp.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    let update: TelegramUpdate;
    try {
      update = JSON.parse(Buffer.concat(chunks).toString()) as TelegramUpdate;
    } catch {
      resp.writeHead(400);
      resp.end();
      return;
    }

    // Responde 200 imediatamente — Telegram tem timeout curto
    resp.writeHead(200);
    resp.end("ok");

    // Publica o evento para processamento assíncrono
    await telegramUpdateReceived.publish({ botId, update });
  },
);

// POST /bots/:botId/webhook/register — alias legacy (use bots.activateWebhook)
export const registerWebhook = api(
  { method: "POST", path: "/bots/:botId/webhook/register", expose: true, auth: true },
  async ({ botId, baseUrl }: { botId: string; baseUrl: string }): Promise<{ ok: boolean }> => {
    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw APIError.notFound("bot not found");

    const token = decrypt(bot.telegramToken);
    const webhookUrl = `${baseUrl}/webhook/${botId}`;

    const res = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url:          webhookUrl,
          secret_token: bot.webhookSecret,
          allowed_updates: ["message", "callback_query", "my_chat_member"],
        }),
      },
    );

    const json = (await res.json()) as { ok: boolean };
    if (!json.ok) throw APIError.internal("failed to register webhook with Telegram");

    return { ok: true };
  },
);
