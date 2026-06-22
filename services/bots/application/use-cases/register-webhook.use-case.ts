import { APIError } from "encore.dev/api";
import { encoreExternalUrl } from "../../../config/secrets.js";
import type { BotRepository } from "../../domain/bot.repository.js";

export class RegisterWebhookUseCase {
  constructor(private readonly repo: BotRepository) {}

  async execute(botId: string, userId: string): Promise<{ ok: boolean }> {
    const bot = await this.repo.findInternalById(botId);
    if (!bot) throw APIError.notFound("bot not found");
    if (bot.userId !== userId) throw APIError.permissionDenied("access denied");

    const baseUrl = encoreExternalUrl();
    if (!baseUrl) throw APIError.internal("ENCORE_EXTERNAL_URL not configured");

    const webhookUrl = `${baseUrl}/webhook/${botId}`;
    const res = await fetch(
      `https://api.telegram.org/bot${bot.telegramToken}/setWebhook`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url:          webhookUrl,
          secret_token: bot.webhookSecret,
          allowed_updates: ["message", "callback_query"],
        }),
      },
    );

    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) {
      throw APIError.internal(`Telegram setWebhook failed: ${json.description ?? "unknown"}`);
    }

    await this.repo.update(botId, userId, { isActive: true });
    return { ok: true };
  }
}
