import type { Funnel, FunnelWithBots, FunnelDetail, CreateFunnelInput, SaveFlowInput } from "./funnel.entity.js";

export interface FunnelRepository {
  findByUserId(userId: string, botId?: string): Promise<FunnelWithBots[]>;
  findById(id: string): Promise<FunnelDetail | null>;
  findByIdOwned(id: string, userId: string): Promise<FunnelDetail | null>;
  create(input: CreateFunnelInput): Promise<Funnel>;
  update(id: string, userId: string, data: Partial<Pick<Funnel, "name" | "isActive" | "simplifiedConfig">>): Promise<Funnel>;
  delete(id: string, userId: string): Promise<void>;
  saveFlow(id: string, userId: string, input: SaveFlowInput): Promise<void>;
  activate(id: string, userId: string): Promise<void>;
  deactivate(id: string, userId: string): Promise<void>;
  duplicate(id: string, userId: string, targetBotId: string): Promise<Funnel>;
  assignBots(id: string, userId: string, botIds: string[]): Promise<void>;
  findActiveFunnelByBotId(botId: string): Promise<FunnelDetail | null>;
}
