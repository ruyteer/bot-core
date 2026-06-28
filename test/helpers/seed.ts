// Builders de dados para os testes: inserem registros reais no PGlite e devolvem
// os ids, espelhando o que o frontend grava. Mantém os testes legíveis.

import { testDb } from "./db.js";
import { encrypt } from "../../services/shared/crypto.js";
import {
  profiles, bots, leads, funnels, funnelNodes, nodeConnections,
  leadProgress, paymentGateways,
} from "../../services/shared/schema/index.js";
import type { TelegramUpdate } from "../../services/shared/events/index.js";

export async function createProfile(): Promise<string> {
  const db = await testDb();
  const [row] = await db.insert(profiles).values({
    id: crypto.randomUUID(),
    email: "test@orionbot.local",
    name: "Tester",
  }).returning();
  return row.id;
}

export async function createBot(opts: { userId?: string; protectContent?: boolean; token?: string } = {}): Promise<{ id: string; userId: string }> {
  const db = await testDb();
  const userId = opts.userId ?? (await createProfile());
  const [row] = await db.insert(bots).values({
    userId,
    name: "Bot de Teste",
    telegramToken: encrypt(opts.token ?? "123456:TEST-TOKEN"),
    isActive: true,
    protectContent: opts.protectContent ?? false,
    webhookSecret: "whsec_test",
  }).returning();
  return { id: row.id, userId };
}

export async function createGateway(opts: { userId: string; provider?: string; clientId?: string; clientSecret?: string }): Promise<string> {
  const db = await testDb();
  const [row] = await db.insert(paymentGateways).values({
    userId: opts.userId,
    provider: opts.provider ?? "buckpay",
    label: "GW Teste",
    clientId: encrypt(opts.clientId ?? "client_test"),
    clientSecret: encrypt(opts.clientSecret ?? "secret_test"),
    isActive: true,
  }).returning();
  return row.id;
}

export async function createLead(botId: string, chatId: bigint): Promise<string> {
  const db = await testDb();
  const [row] = await db.insert(leads).values({
    botId,
    telegramChatId: chatId,
    firstName: "Lead",
  }).returning();
  return row.id;
}

export interface NodeSpec {
  key: string;                 // apelido local para ligar conexões
  type: string;
  content?: Record<string, unknown>;
}
export interface ConnSpec {
  from: string;                // key do nó de origem
  to: string;                  // key do nó de destino
  handle?: string;             // source_handle
}

/**
 * Cria um funil de FLUXO completo (funnel + nós + conexões) e devolve os ids
 * reais por apelido. Sempre exige um nó "trigger".
 */
export async function createFlowFunnel(opts: {
  userId: string;
  botId: string;
  isActive?: boolean;
  nodes: NodeSpec[];
  connections: ConnSpec[];
  kind?: string;
}): Promise<{ funnelId: string; nodeIds: Record<string, string> }> {
  const db = await testDb();
  const [funnel] = await db.insert(funnels).values({
    userId: opts.userId,
    botId: opts.botId,
    name: "Funil de Teste",
    kind: opts.kind ?? "flow",
    isActive: opts.isActive ?? true,
  }).returning();

  const nodeIds: Record<string, string> = {};
  for (const n of opts.nodes) {
    const [row] = await db.insert(funnelNodes).values({
      funnelId: funnel.id,
      type: n.type as never,
      content: n.content ?? {},
    }).returning();
    nodeIds[n.key] = row.id;
  }

  for (const c of opts.connections) {
    await db.insert(nodeConnections).values({
      funnelId: funnel.id,
      sourceNodeId: nodeIds[c.from],
      sourceHandle: c.handle ?? null,
      targetNodeId: nodeIds[c.to],
    });
  }

  return { funnelId: funnel.id, nodeIds };
}

/** Cria um funil SIMPLIFICADO (interpretado, sem nós) com o config dado. */
export async function createSimplifiedFunnel(opts: {
  userId: string;
  botId: string;
  config: Record<string, unknown>;
  isActive?: boolean;
  kind?: string;
}): Promise<string> {
  const db = await testDb();
  const [funnel] = await db.insert(funnels).values({
    userId: opts.userId,
    botId: opts.botId,
    name: "Funil Simplificado de Teste",
    kind: opts.kind ?? "simplified",
    isActive: opts.isActive ?? true,
    simplifiedConfig: opts.config,
  }).returning();
  return funnel.id;
}

export async function getProgress(leadId: string) {
  const db = await testDb();
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(leadProgress).where(eq(leadProgress.leadId, leadId));
  return row;
}

// ── Construtores de updates do Telegram ────────────────────────────────────────

let updateId = 1;

export function startUpdate(chatId: number, opts: { firstName?: string; username?: string } = {}): TelegramUpdate {
  return textUpdate(chatId, "/start", opts);
}

export function textUpdate(chatId: number, text: string, opts: { firstName?: string; username?: string } = {}): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, first_name: opts.firstName ?? "Lead", username: opts.username },
      text,
      date: Math.floor(Date.now() / 1000),
    },
  };
}

export function callbackUpdate(chatId: number, data: string, messageId = 999): TelegramUpdate {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cbq_${updateId}`,
      from: { id: chatId, first_name: "Lead" },
      message: { message_id: messageId, chat: { id: chatId, type: "private" }, date: 0 },
      data,
    },
  };
}

export function myChatMemberUpdate(chatId: number, status: string, type = "supergroup"): TelegramUpdate {
  return {
    update_id: updateId++,
    my_chat_member: {
      chat: { id: chatId, type, title: "Grupo X" },
      from: { id: 1, first_name: "Owner" },
      new_chat_member: { status, user: { id: 42, is_bot: true } },
      old_chat_member: { status: "left" },
    },
  };
}
