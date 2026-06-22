import { APIError } from "encore.dev/api";
import type { Bot, UpdateBotInput } from "../../domain/bot.entity.js";
import type { BotRepository } from "../../domain/bot.repository.js";

export class UpdateBotUseCase {
  constructor(private readonly repo: BotRepository) {}

  async execute(id: string, userId: string, input: UpdateBotInput): Promise<Bot> {
    const belongs = await this.repo.belongsToUser(id, userId);
    if (!belongs) throw APIError.notFound("bot not found");
    return this.repo.update(id, userId, input);
  }
}
