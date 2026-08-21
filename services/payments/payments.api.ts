import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { encoreExternalUrl } from "../config/secrets.js";
import { GatewayDrizzleRepository } from "./infrastructure/gateway.drizzle.repository.js";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { createPix } from "./application/gateway-clients.js";
import { isPlatformAdmin } from "../shared/roles.js";
import { db } from "../shared/database.js";
import { leads } from "../shared/schema/index.js";
import { inArray } from "drizzle-orm";
import type { Provider } from "./domain/gateway.entity.js";
import type { PaymentWithMeta } from "./domain/payment.entity.js";

const gwRepo  = new GatewayDrizzleRepository();
const payRepo = new PaymentDrizzleRepository();

// ─── Response shapes ─────────────────────────────────────────────────────────

interface GatewayResponse {
  id:       string;
  provider: string;
  label:    string;
  isActive: boolean;
}

interface PaymentResponse {
  id:               string;
  createdAt:        string;
  paidAt:           string | null;
  status:           string;
  amount:           number;
  offerId:          string | null;
  saleType:         string | null;
  offerName:        string | null;
  description:      string | null;
  botId:            string;
  botName:          string | null;
  botUsername:      string | null;
  leadId:           string | null;
  leadName:         string | null;
  leadUsername:     string | null;
  leadChatId:       string | null;
  provider:         string | null;
  gatewayLabel:     string | null;
  externalId:       string | null;
  // Atribuição do lead que gerou a venda. Antes o painel inferia "receita de
  // anúncios" pela presença de @username e "campanha" pelo nome do produto —
  // os dados reais já existiam na tabela `leads` e não eram expostos.
  leadUtmSource:    string | null;
  leadUtmMedium:    string | null;
  leadUtmCampaign:  string | null;
  leadUtmContent:   string | null;
  leadUtmTerm:      string | null;
  leadFbclid:       string | null;
  leadTtclid:       string | null;
}

interface LeadAttribution {
  utmSource:   string | null;
  utmMedium:   string | null;
  utmCampaign: string | null;
  utmContent:  string | null;
  utmTerm:     string | null;
  fbclid:      string | null;
  ttclid:      string | null;
}

// Uma linha por lead, casada por id → 1:1 com o pagamento, sem inflar nada.
async function loadLeadAttribution(leadIds: string[]): Promise<Map<string, LeadAttribution>> {
  const map = new Map<string, LeadAttribution>();
  if (leadIds.length === 0) return map;
  const rows = await db.select({
    id:          leads.id,
    utmSource:   leads.utmSource,
    utmMedium:   leads.utmMedium,
    utmCampaign: leads.utmCampaign,
    utmContent:  leads.utmContent,
    utmTerm:     leads.utmTerm,
    fbclid:      leads.fbclid,
    ttclid:      leads.ttclid,
  }).from(leads).where(inArray(leads.id, leadIds));
  for (const r of rows) {
    map.set(r.id, {
      utmSource:   r.utmSource   ?? null,
      utmMedium:   r.utmMedium   ?? null,
      utmCampaign: r.utmCampaign ?? null,
      utmContent:  r.utmContent  ?? null,
      utmTerm:     r.utmTerm     ?? null,
      fbclid:      r.fbclid      ?? null,
      ttclid:      r.ttclid      ?? null,
    });
  }
  return map;
}

function toPaymentResponse(p: PaymentWithMeta, attr?: LeadAttribution): PaymentResponse {
  return {
    id:           p.id,
    createdAt:    p.createdAt.toISOString(),
    paidAt:       p.paidAt?.toISOString() ?? null,
    status:       p.status,
    amount:       p.amount,
    offerId:      p.offerId,
    saleType:     p.saleType,
    offerName:    p.offerName,
    description:  p.description,
    botId:        p.botId,
    botName:      p.botName,
    botUsername:  p.botUsername,
    leadId:       p.leadId,
    leadName:     p.leadName,
    leadUsername: p.leadUsername,
    leadChatId:   p.leadChatId,
    provider:     p.provider,
    gatewayLabel: p.gatewayLabel,
    externalId:   p.externalId,
    leadUtmSource:   attr?.utmSource   ?? null,
    leadUtmMedium:   attr?.utmMedium   ?? null,
    leadUtmCampaign: attr?.utmCampaign ?? null,
    leadUtmContent:  attr?.utmContent  ?? null,
    leadUtmTerm:     attr?.utmTerm     ?? null,
    leadFbclid:      attr?.fbclid      ?? null,
    leadTtclid:      attr?.ttclid      ?? null,
  };
}

// ─── Gateways endpoints ───────────────────────────────────────────────────────

// GET /gateways
export const listGateways = api(
  { method: "GET", path: "/gateways", expose: true, auth: true },
  async (): Promise<{ gateways: GatewayResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    const gws = await gwRepo.findByUserId(userId);
    return { gateways: gws };
  },
);

// POST /gateways
export const createGateway = api(
  { method: "POST", path: "/gateways", expose: true, auth: true },
  async (req: { provider: string; label: string; clientId: string; clientSecret: string }): Promise<GatewayResponse> => {
    const { userID: userId } = getAuthData()!;
    const validProviders: Provider[] = ["syncpay", "buckpay", "nexuspag", "wiinpay"];
    if (!validProviders.includes(req.provider as Provider)) {
      throw APIError.invalidArgument("invalid provider");
    }
    return gwRepo.create({
      userId,
      provider:     req.provider as Provider,
      label:        req.label,
      clientId:     req.clientId,
      clientSecret: req.clientSecret,
    });
  },
);

// PATCH /gateways/:id
export const updateGateway = api(
  { method: "PATCH", path: "/gateways/:id", expose: true, auth: true },
  async ({ id, label, clientId, clientSecret }: { id: string; label?: string; clientId?: string; clientSecret?: string }): Promise<GatewayResponse> => {
    const { userID: userId } = getAuthData()!;
    return gwRepo.update(id, userId, { label, clientId, clientSecret });
  },
);

// POST /gateways/:id/toggle
export const toggleGateway = api(
  { method: "POST", path: "/gateways/:id/toggle", expose: true, auth: true },
  async ({ id, isActive }: { id: string; isActive: boolean }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await gwRepo.toggle(id, userId, isActive);
    return { ok: true };
  },
);

// DELETE /gateways/:id
export const deleteGateway = api(
  { method: "DELETE", path: "/gateways/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<void> => {
    const { userID: userId } = getAuthData()!;
    await gwRepo.delete(id, userId);
  },
);

interface BotGatewayChainItem {
  id:       string;
  provider: string;
  label:    string;
  isActive: boolean;
  position: number;
}

// GET /bots/:id/gateways — ordem de fallback de gateways do bot.
// O parâmetro PRECISA se chamar `id`: o serviço de bots já registra
// `/bots/:id/...` e o roteador não aceita dois nomes de parâmetro na mesma
// posição da árvore. Com `:botId` a rota era silenciosamente descartada (404).
export const listBotGateways = api(
  { method: "GET", path: "/bots/:id/gateways", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ gateways: BotGatewayChainItem[] }> => {
    const { userID: userId } = getAuthData()!;
    const gateways = await gwRepo.listChain(id, userId);
    return { gateways };
  },
);

// PUT /bots/:id/gateways — substitui a ordem inteira (índice = prioridade)
export const setBotGateways = api(
  { method: "PUT", path: "/bots/:id/gateways", expose: true, auth: true },
  async ({ id, gatewayIds }: { id: string; gatewayIds: string[] }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const ok = await gwRepo.setChain(id, userId, gatewayIds);
    if (!ok) throw APIError.notFound("bot not found");
    return { ok: true };
  },
);

// POST /gateways/:id/test — gera um PIX de R$ 10,00 para teste
export const testGateway = api(
  { method: "POST", path: "/gateways/:id/test", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{
    success:     boolean;
    pixCode:     string;
    qrImage:     string;
    externalId:  string;
    amount:      number;
    provider:    string;
    institution: string;
  }> => {
    const { userID: userId } = getAuthData()!;
    const gw = await gwRepo.findByIdOwned(id, userId);
    if (!gw) throw APIError.notFound("gateway not found");

    const { clientId, clientSecret } = gwRepo.decryptCredentials(gw);
    const externalUrl = encoreExternalUrl();
    const webhookUrl  = `${externalUrl}/payments/webhook/${gw.provider}`;

    // Admin testando não paga a taxa da plataforma → PIX de teste sem split.
    const skipSplit = await isPlatformAdmin(userId);

    try {
      const result = await createPix(gw.provider, clientId, clientSecret, 1000, "Teste OrionBot R$ 10,00", webhookUrl, { skipSplit });
      return { success: true, ...result };
    } catch (err) {
      // Sem isso o Encore converte o Error em "internal error" genérico e o
      // painel não mostra a causa real (ex.: 403 de compliance do provedor).
      const msg = err instanceof Error ? err.message : String(err);
      throw APIError.unavailable(`Falha ao gerar PIX de teste: ${msg}`);
    }
  },
);

// ─── Payments endpoints ───────────────────────────────────────────────────────

// GET /payments?botId=...&start=...&end=...
export const listPayments = api(
  { method: "GET", path: "/payments", expose: true, auth: true },
  async ({ botId, start, end }: { botId?: string; start?: string; end?: string }): Promise<{ payments: PaymentResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    // O botId vem do query param: sem checar posse, qualquer usuário autenticado
    // lia os pagamentos de um bot alheio passando o uuid dele.
    const userBotIds = await payRepo.getUserBotIds(userId);
    if (botId && !userBotIds.includes(botId)) throw APIError.notFound("bot not found");
    const botIds = botId ? [botId] : userBotIds;
    const startDate = start ? new Date(start) : undefined;
    const endDate   = end   ? new Date(end)   : undefined;
    const result    = await payRepo.findByBotIds(botIds, startDate, endDate);
    const attrByLead = await loadLeadAttribution([...new Set(result.map((p) => p.leadId).filter((v): v is string => !!v))]);
    return { payments: result.map((p) => toPaymentResponse(p, p.leadId ? attrByLead.get(p.leadId) : undefined)) };
  },
);
