import type { Bot, BotInternal, BotWithStats, CreateBotInput, UpdateBotInput } from "./bot.entity.js";

export interface BotRepository {
  create(input: CreateBotInput & { webhookSecret: string; encryptedToken: string }): Promise<Bot>;
  findByUserId(userId: string): Promise<BotWithStats[]>;
  findById(id: string): Promise<Bot | null>;
  findInternalById(id: string): Promise<BotInternal | null>;
  update(id: string, userId: string, input: UpdateBotInput & { telegramUsername?: string }): Promise<Bot>;
  delete(id: string, userId: string): Promise<void>;
  belongsToUser(id: string, userId: string): Promise<boolean>;
}
