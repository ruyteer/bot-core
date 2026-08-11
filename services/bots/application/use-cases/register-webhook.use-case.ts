import { APIError } from "encore.dev/api";
import type { BotRepository } from "../../domain/bot.repository.js";
import { setTelegramWebhook } from "../telegram-webhook.js";

export class RegisterWebhookUseCase {
  constructor(private readonly repo: BotRepository) {}

  async execute(botId: string, userId: string): Promise<{ ok: boolean }> {
    const bot = await this.repo.findInternalById(botId);
    if (!bot) throw APIError.notFound("bot not found");
    if (bot.userId !== userId) throw APIError.permissionDenied("access denied");

    const result = await setTelegramWebhook({
      botId,
      telegramToken: bot.telegramToken,
      webhookSecret: bot.webhookSecret,
    });

    // Reativação manual falha alto: quem clicou em "Reconectar" precisa ver o
    // motivo. (Na criação do bot a mesma falha é tolerada — ver CreateBotUseCase.)
    if (!result.ok) {
      throw APIError.internal(`Telegram setWebhook failed: ${result.reason}`);
    }

    await this.repo.update(botId, userId, { isActive: true });
    return { ok: true };
  }
}
