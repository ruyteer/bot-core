import type { Lead, LeadWithStats, LeadMessage, UpsertLeadInput } from "./lead.entity.js";

export interface LeadRepository {
  findByBotIds(botIds: string[], startDate?: Date, endDate?: Date): Promise<LeadWithStats[]>;
  findById(id: string): Promise<LeadWithStats | null>;
  findByTelegramChatId(botId: string, telegramChatId: bigint): Promise<Lead | null>;
  upsert(input: UpsertLeadInput): Promise<Lead>;
  getMessages(leadId: string, limit?: number): Promise<LeadMessage[]>;
  saveMessage(leadId: string, botId: string, direction: "inbound" | "outbound", content: Record<string, unknown>): Promise<LeadMessage>;
  setPaused(leadId: string, paused: boolean): Promise<void>;
  isLeadPaused(leadId: string): Promise<boolean>;
  getUserBotIds(userId: string): Promise<string[]>;
}
