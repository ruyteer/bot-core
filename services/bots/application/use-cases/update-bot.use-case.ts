import { eq, and } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import { db } from "../../../shared/database.js";
import { paymentGateways } from "../../../shared/schema/index.js";
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

    // O gateway virando "padrão" do bot precisa ser DO MESMO usuário — sem
    // isto, um PATCH com o id de um gateway de OUTRO usuário (ex.: adivinhado
    // ou visto num payload de outra tela) vinculava o bot ao gateway alheio,
    // sem nenhuma validação de posse (o WHERE do update() só protegia a linha
    // do bot, nunca o valor que estava sendo gravado nela).
    if (input.defaultGatewayId !== undefined && input.defaultGatewayId !== null) {
      const [owned] = await db.select({ id: paymentGateways.id }).from(paymentGateways)
        .where(and(eq(paymentGateways.id, input.defaultGatewayId), eq(paymentGateways.userId, userId)))
        .limit(1);
      if (!owned) throw APIError.notFound("gateway not found");
    }

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
