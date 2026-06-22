import { APIError } from "encore.dev/api";
import type { BotRepository } from "../../domain/bot.repository.js";

export class DeregisterWebhookUseCase {
  constructor(private readonly repo: BotRepository) {}

  async execute(botId: string, userId: string): Promise<{ ok: boolean }> {
    const bot = await this.repo.findInternalById(botId);
    if (!bot) throw APIError.notFound("bot not found");
    if (bot.userId !== userId) throw APIError.permissionDenied("access denied");

    const res = await fetch(
      `https://api.telegram.org/bot${bot.telegramToken}/deleteWebhook`,
      { method: "POST" },
    );

    const json = (await res.json()) as { ok: boolean };
    if (!json.ok) throw APIError.internal("Telegram deleteWebhook failed");

    await this.repo.update(botId, userId, { isActive: false });
    return { ok: true };
  }
}
