import { APIError } from "encore.dev/api";
import type { Bot } from "../../domain/bot.entity.js";
import type { BotRepository } from "../../domain/bot.repository.js";

interface TelegramGetMeResponse {
  ok: boolean;
  result?: { username?: string; first_name: string };
}

export class SyncBotProfileUseCase {
  constructor(private readonly repo: BotRepository) {}

  // Substitui a Edge Function "update-bot-profile"
  async execute(botId: string, userId: string): Promise<Bot> {
    const bot = await this.repo.findInternalById(botId);
    if (!bot) throw APIError.notFound("bot not found");
    if (bot.userId !== userId) throw APIError.permissionDenied("access denied");

    const res = await fetch(`https://api.telegram.org/bot${bot.telegramToken}/getMe`);
    const data = (await res.json()) as TelegramGetMeResponse;
    if (!data.ok) throw APIError.internal("failed to fetch bot profile from Telegram");

    return this.repo.update(botId, userId, {
      telegramUsername: data.result?.username ?? undefined,
    });
  }
}
