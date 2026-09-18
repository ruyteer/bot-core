import { APIError } from "encore.dev/api";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./database.js";
import { bots, botGroups } from "./schema/index.js";

// Mesma regex usada em process-broadcasts.use-case.ts / notifications.api.ts /
// funnel.drizzle.repository.ts. bots.id é uuid no schema — um id malformado
// nunca vai bater na query, mas SEM essa checagem o driver Postgres estoura
// "invalid input syntax for type uuid" cru (500) em vez de um 404 limpo.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Checagem de posse de bot, usada por qualquer endpoint que grave um botId
// vindo do cliente (funis, broadcasts, ofertas...). botId é público (aparece
// na URL de tracking `GET /r?b=<botId>`), então nunca confie nele sem checar
// contra o userId autenticado.
export async function assertBotOwnership(botId: string, userId: string): Promise<void> {
  if (!UUID_REGEX.test(botId)) throw APIError.notFound("bot not found");
  const row = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId))).limit(1);
  if (!row.length) throw APIError.notFound("bot not found");
}

// Versão em lote: uma query só, falha se QUALQUER id do array não pertencer ao usuário.
export async function assertBotsOwnership(botIds: string[], userId: string): Promise<void> {
  if (botIds.length === 0) return;
  if (botIds.some((id) => !UUID_REGEX.test(id))) throw APIError.notFound("bot not found");
  const uniqueIds = [...new Set(botIds)];
  const rows = await db.select({ id: bots.id }).from(bots)
    .where(and(inArray(bots.id, uniqueIds), eq(bots.userId, userId)));
  if (rows.length !== uniqueIds.length) throw APIError.notFound("bot not found");
}

// Checagem de posse de grupo (bot_groups.id), usada por qualquer endpoint que grave um
// telegramGroupId/targetGroupId vindo do cliente (ofertas VIP, broadcasts, remarketing).
// bot_groups.id nunca é exposto a quem não é dono do bot (GET /bots/:id/groups já checa
// posse), mas mesmo assim nunca confiamos numa FK vinda do cliente sem revalidar aqui —
// mesmo princípio de assertBotOwnership.
// scopeBotId, quando informado, exige que o grupo pertença exatamente a ESSE bot (ex.:
// oferta VIP — o convite é criado com o token do bot da própria oferta, então um grupo de
// OUTRO bot do mesmo usuário também falharia — silenciosamente — no Telegram).
export async function assertGroupOwnership(groupId: string, userId: string, scopeBotId?: string): Promise<void> {
  if (!UUID_REGEX.test(groupId)) throw APIError.notFound("group not found");
  const conditions = [eq(botGroups.id, groupId), eq(bots.userId, userId)];
  if (scopeBotId) conditions.push(eq(botGroups.botId, scopeBotId));
  const rows = await db.select({ id: botGroups.id }).from(botGroups)
    .innerJoin(bots, eq(botGroups.botId, bots.id))
    .where(and(...conditions)).limit(1);
  if (!rows.length) throw APIError.notFound("group not found");
}

// Versão em lote de assertGroupOwnership: uma query só, falha se QUALQUER id do array
// não pertencer a um bot do usuário.
export async function assertGroupsOwnership(groupIds: string[], userId: string): Promise<void> {
  if (groupIds.length === 0) return;
  if (groupIds.some((id) => !UUID_REGEX.test(id))) throw APIError.notFound("group not found");
  const uniqueIds = [...new Set(groupIds)];
  const rows = await db.select({ id: botGroups.id }).from(botGroups)
    .innerJoin(bots, eq(botGroups.botId, bots.id))
    .where(and(inArray(botGroups.id, uniqueIds), eq(bots.userId, userId)));
  if (rows.length !== uniqueIds.length) throw APIError.notFound("group not found");
}
