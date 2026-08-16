import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { LeadDrizzleRepository } from "./infrastructure/lead.drizzle.repository.js";
import { decrypt } from "../shared/crypto.js";
import { db } from "../shared/database.js";
import { bots } from "../shared/schema/index.js";
import { eq } from "drizzle-orm";
import type { LeadWithStats } from "./domain/lead.entity.js";
import { getLeadAnalytics } from "./application/lead-analytics.js";
import type { LeadAnalytics } from "./application/lead-analytics.js";
import { TelegramClient, TelegramApiError } from "../runner/application/telegram.client.js";

const repo = new LeadDrizzleRepository();

async function assertLeadOwnership(leadId: string, userId: string) {
  const lead = await repo.findById(leadId);
  if (!lead) throw APIError.notFound("lead not found");
  const userBotIds = await repo.getUserBotIds(userId);
  if (!userBotIds.includes(lead.botId)) throw APIError.notFound("lead not found");
  return lead;
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

interface LeadResponse {
  id:               string;
  botId:            string;
  botName:          string | null;
  telegramChatId:   string;
  telegramUsername: string | null;
  firstName:        string | null;
  lastName:         string | null;
  utmSource:        string | null;
  utmCampaign:      string | null;
  utmMedium:        string | null;
  status:           string | null;
  funnelName:       string | null;
  nodeSummary:      string | null;
  conversionTimeMs: number | null;
  createdAt:        string;
}

function toResponse(l: LeadWithStats): LeadResponse {
  return {
    id:               l.id,
    botId:            l.botId,
    botName:          l.botName,
    telegramChatId:   l.telegramChatId.toString(),
    telegramUsername: l.telegramUsername,
    firstName:        l.firstName,
    lastName:         l.lastName,
    utmSource:        l.utmSource,
    utmCampaign:      l.utmCampaign,
    utmMedium:        l.utmMedium,
    status:           l.progress?.status ?? null,
    funnelName:       l.progress?.funnelName ?? null,
    nodeSummary:      l.progress?.nodeSummary ?? null,
    conversionTimeMs: l.conversionTimeMs,
    createdAt:        l.createdAt.toISOString(),
  };
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// GET /leads?botId=...&start=...&end=...
export const list = api(
  { method: "GET", path: "/leads", expose: true, auth: true },
  async ({ botId, start, end }: { botId?: string; start?: string; end?: string }): Promise<{ leads: LeadResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    const userBotIds = await repo.getUserBotIds(userId);
    if (botId && !userBotIds.includes(botId)) throw APIError.notFound("bot not found");
    const botIds = botId ? [botId] : userBotIds;
    const startDate = start ? new Date(start) : undefined;
    const endDate   = end   ? new Date(end)   : undefined;
    const result    = await repo.findByBotIds(botIds, startDate, endDate);
    return { leads: result.map(toResponse) };
  },
);

interface LeadStatsResponse {
  /** Total de comandos /start no período (conta repetição do mesmo lead). */
  starts:      number;
  /** Leads distintos que deram /start no período. */
  activeLeads: number;
  /** Leads criados no período (primeiro contato). */
  newLeads:    number;
}

// GET /leads/stats?botId=...&start=...&end=...
// Existe porque a tabela `leads` guarda uma linha por (bot, chat): dava para
// contar pessoas, nunca interações. O painel usava a contagem de leads como
// "total de starts", e "starts por lead" saía sempre 1,00.
export const stats = api(
  { method: "GET", path: "/leads/stats", expose: true, auth: true },
  async ({ botId, start, end }: { botId?: string; start?: string; end?: string }): Promise<LeadStatsResponse> => {
    const { userID: userId } = getAuthData()!;
    const userBotIds = await repo.getUserBotIds(userId);
    if (botId && !userBotIds.includes(botId)) throw APIError.notFound("bot not found");
    const botIds = botId ? [botId] : userBotIds;
    if (botIds.length === 0) return { starts: 0, activeLeads: 0, newLeads: 0 };

    const startDate = start ? new Date(start) : undefined;
    const endDate   = end   ? new Date(end)   : undefined;
    return repo.getStats(botIds, startDate, endDate);
  },
);

// GET /leads/analytics?botId=...&start=...&end=...
// Comportamento dos leads: em que etapa pararam, onde não avançaram e de que
// fonte de tráfego vieram. Toda a agregação acontece no SQL, sobre um único
// escopo (bot + janela), para as visões fecharem entre si.
// Precisa vir ANTES de /leads/:id na leitura do arquivo? Não — o router do
// Encore prioriza segmentos estáticos (mesmo caso de /leads/stats).
export const analytics = api(
  { method: "GET", path: "/leads/analytics", expose: true, auth: true },
  async ({ botId, start, end }: { botId?: string; start?: string; end?: string }): Promise<LeadAnalytics> => {
    const { userID: userId } = getAuthData()!;
    const userBotIds = await repo.getUserBotIds(userId);
    if (botId && !userBotIds.includes(botId)) throw APIError.notFound("bot not found");
    const botIds = botId ? [botId] : userBotIds;

    const startDate = start ? new Date(start) : undefined;
    const endDate   = end   ? new Date(end)   : undefined;
    return getLeadAnalytics(botIds, startDate, endDate);
  },
);

// GET /leads/:id
export const get = api(
  { method: "GET", path: "/leads/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<LeadResponse> => {
    const { userID: userId } = getAuthData()!;
    const lead = await assertLeadOwnership(id, userId);
    return toResponse(lead);
  },
);

// GET /leads/:id/messages
export const getMessages = api(
  { method: "GET", path: "/leads/:id/messages", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ messages: Array<{ id: string; direction: string; content: Record<string, unknown>; createdAt: string }> }> => {
    const { userID: userId } = getAuthData()!;
    await assertLeadOwnership(id, userId);
    const msgs = await repo.getMessages(id, 200);
    return {
      messages: msgs.map((m) => ({
        id:        m.id,
        direction: m.direction,
        content:   m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  },
);

// POST /leads/:id/pause — toggle pause/resume
export const togglePause = api(
  { method: "POST", path: "/leads/:id/pause", expose: true, auth: true },
  async ({ id, pause }: { id: string; pause: boolean }): Promise<{ ok: boolean; paused: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await assertLeadOwnership(id, userId);
    await repo.setPaused(id, pause);
    return { ok: true, paused: pause };
  },
);

// POST /leads/:id/message — send message on behalf of the bot
export const sendMessage = api(
  { method: "POST", path: "/leads/:id/message", expose: true, auth: true },
  async ({ id, kind, text, mediaUrl }: { id: string; kind: string; text?: string; mediaUrl?: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const lead = await assertLeadOwnership(id, userId);

    const [bot] = await db.select().from(bots).where(eq(bots.id, lead.botId));
    if (!bot) throw APIError.notFound("bot not found");

    const token = decrypt(bot.telegramToken);
    const chatId = lead.telegramChatId.toString();
    // botId habilita o cache de file_id (media_cache) — sem isso, este era o
    // único endpoint de envio que rebaixava o arquivo do storage a CADA
    // mensagem, em vez de reusar o file_id já cacheado pelo resto do runner.
    const tg = new TelegramClient(token, lead.botId);

    try {
      if (kind === "text" && text) {
        await tg.sendMessage({ chatId, text });
      } else if (kind === "photo" && mediaUrl) {
        await tg.sendPhoto({ chatId, photo: mediaUrl });
      } else {
        throw APIError.invalidArgument("unsupported message kind or missing content");
      }
    } catch (err) {
      if (err instanceof TelegramApiError) throw APIError.internal(err.message);
      throw err;
    }

    await repo.saveMessage(id, lead.botId, "outbound", { kind, text, mediaUrl });
    return { ok: true };
  },
);
