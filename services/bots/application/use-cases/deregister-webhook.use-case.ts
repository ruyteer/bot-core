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

    const json = (await res.json()) as { ok: boolean; error_code?: number; description?: string };

    // Token revogado/apagado no BotFather (401/404): o webhook já está morto do
    // lado do Telegram — desativa localmente mesmo assim, senão o usuário fica
    // preso sem conseguir desligar o bot.
    if (!json.ok && json.error_code !== 401 && json.error_code !== 404) {
      throw APIError.internal(
        `Telegram deleteWebhook falhou (${json.error_code ?? "?"}): ${json.description ?? "sem descrição"}`,
      );
    }
    if (!json.ok) {
      console.warn(`[bots] deleteWebhook: token inválido p/ bot ${botId} (${json.error_code}: ${json.description}) — desativando localmente`);
    }

    await this.repo.update(botId, userId, { isActive: false });
    return { ok: true };
  }
}
