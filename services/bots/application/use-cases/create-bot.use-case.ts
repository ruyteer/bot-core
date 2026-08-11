import { APIError } from "encore.dev/api";
import { randomBytes } from "node:crypto";
import { encrypt } from "../../../shared/crypto.js";
import type { Bot, CreateBotInput } from "../../domain/bot.entity.js";
import type { BotRepository } from "../../domain/bot.repository.js";
import { setTelegramWebhook } from "../telegram-webhook.js";

interface TelegramGetMeResponse {
  ok:     boolean;
  result?: { id: number; username?: string; first_name: string };
}

export class CreateBotUseCase {
  constructor(private readonly repo: BotRepository) {}

  async execute(input: CreateBotInput): Promise<Bot> {
    // Validate token with Telegram before saving
    const res = await fetch(`https://api.telegram.org/bot${input.telegramToken}/getMe`);
    const data = (await res.json()) as TelegramGetMeResponse;
    if (!data.ok) {
      throw APIError.invalidArgument("invalid Telegram token — getMe failed");
    }

    const webhookSecret  = randomBytes(24).toString("hex");
    const encryptedToken = encrypt(input.telegramToken);

    const bot = await this.repo.create({
      userId:        input.userId,
      name:          input.name,
      telegramToken: input.telegramToken,
      webhookSecret,
      encryptedToken,
    });

    // Registrar o webhook aqui, e não no cliente.
    //
    // Antes isto era responsabilidade da UI: `BotSelector` chamava
    // `activateWebhook` logo após criar, e `MeusBots` não chamava — então um
    // bot criado pela tela "Meus Bots" nascia sem webhook, anunciava "Bot
    // criado e ativado!" e só recebia updates depois que alguém clicasse em
    // "Reconectar". Orquestração que todo cliente precisa lembrar de repetir é
    // orquestração que um cliente vai esquecer.
    //
    // `is_active` tem default `true` no schema, o que deixava o bot quebrado
    // aparecendo como ativo. Aqui ele passa a refletir a realidade: só fica
    // ativo se o Telegram aceitou o webhook.
    const webhook = await setTelegramWebhook({
      botId:         bot.id,
      telegramToken: input.telegramToken,
      webhookSecret,
    });

    const patch: { telegramUsername?: string; isActive: boolean } = { isActive: webhook.ok };
    if (data.result?.username) patch.telegramUsername = data.result.username;

    return this.repo.update(bot.id, input.userId, patch);
  }
}
