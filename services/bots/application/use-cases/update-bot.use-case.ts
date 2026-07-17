import { APIError } from "encore.dev/api";
import { encrypt } from "../../../shared/crypto.js";
import type { Bot, UpdateBotInput } from "../../domain/bot.entity.js";
import type { BotRepository } from "../../domain/bot.repository.js";

export class UpdateBotUseCase {
  constructor(private readonly repo: BotRepository) {}

  async execute(
    id: string,
    userId: string,
    input: Omit<UpdateBotInput, "telegramToken"> & { telegramToken?: string },
  ): Promise<Bot> {
    const belongs = await this.repo.belongsToUser(id, userId);
    if (!belongs) throw APIError.notFound("bot not found");

    // Troca de token (ex.: token revogado no BotFather): valida com getMe,
    // re-criptografa e sincroniza o username. Depois é preciso reativar o
    // webhook no painel (setWebhook usa o token novo).
    let extra: { telegramToken?: string; telegramUsername?: string } = {};
    if (input.telegramToken !== undefined) {
      const raw = input.telegramToken.trim();
      if (!raw) throw APIError.invalidArgument("token vazio");
      const res = await fetch(`https://api.telegram.org/bot${raw}/getMe`);
      const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
      if (!data.ok) throw APIError.invalidArgument("token inválido — getMe falhou no Telegram");
      extra = {
        telegramToken: encrypt(raw),
        ...(data.result?.username ? { telegramUsername: data.result.username } : {}),
      };
    }

    const { telegramToken: _ignored, ...rest } = input;
    return this.repo.update(id, userId, { ...rest, ...extra });
  }
}
