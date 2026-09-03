import type { Funnel, FunnelWithBots, FunnelDetail, CreateFunnelInput, SaveFlowInput } from "./funnel.entity.js";

export interface FunnelRepository {
  findByUserId(userId: string, botId?: string): Promise<FunnelWithBots[]>;
  findById(id: string): Promise<FunnelDetail | null>;
  findByIdOwned(id: string, userId: string): Promise<FunnelDetail | null>;
  create(input: CreateFunnelInput): Promise<Funnel>;
  // `isActive` de propósito FORA deste Pick: a única forma de ligar um funil
  // precisa passar por `activate()`, que valida completude de oferta antes
  // (ver `assertFunnelReadyToActivate` em `funnels.api.ts`) — permitir setar
  // isActive aqui reabriria esse bypass sem nenhum erro de compilação avisando.
  update(id: string, userId: string, data: Partial<Pick<Funnel, "name" | "simplifiedConfig">>): Promise<Funnel>;
  delete(id: string, userId: string): Promise<void>;
  saveFlow(id: string, userId: string, input: SaveFlowInput): Promise<void>;
  activate(id: string, userId: string): Promise<void>;
  deactivate(id: string, userId: string): Promise<void>;
  duplicate(id: string, userId: string, targetBotId: string): Promise<Funnel>;
  assignBots(id: string, userId: string, botIds: string[]): Promise<void>;
  findActiveFunnelByBotId(botId: string): Promise<FunnelDetail | null>;
}
