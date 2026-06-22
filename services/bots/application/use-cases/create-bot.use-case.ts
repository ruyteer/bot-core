import { APIError } from "encore.dev/api";
import { randomBytes } from "node:crypto";
import { encrypt } from "../../../shared/crypto.js";
import type { Bot, CreateBotInput } from "../../domain/bot.entity.js";
import type { BotRepository } from "../../domain/bot.repository.js";

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

    // Sync username from Telegram
    if (data.result?.username) {
      return this.repo.update(bot.id, input.userId, {
        telegramUsername: data.result.username,
      });
    }
    return bot;
  }
}
