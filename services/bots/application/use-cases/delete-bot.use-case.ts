import { APIError } from "encore.dev/api";
import type { BotRepository } from "../../domain/bot.repository.js";

export class DeleteBotUseCase {
  constructor(private readonly repo: BotRepository) {}

  async execute(id: string, userId: string): Promise<void> {
    const belongs = await this.repo.belongsToUser(id, userId);
    if (!belongs) throw APIError.notFound("bot not found");
    await this.repo.delete(id, userId);
  }
}
