import { api } from "encore.dev/api";
import { inArray } from "drizzle-orm";
import { db } from "../shared/database.js";
import { platformConfig } from "../shared/schema/index.js";

const WHATSAPP_SUPPORT_PHONE_KEY   = "WHATSAPP_SUPPORT_PHONE";
const WHATSAPP_SUPPORT_MESSAGE_KEY = "WHATSAPP_SUPPORT_MESSAGE";

// providers de gateway PIX suportados — chave curta exposta ao cliente ↔ chave
// interna em platform_config (GATEWAY_AFFILIATE_URL_<PROVIDER>).
const GATEWAY_AFFILIATE_PROVIDERS = ["syncpay", "buckpay", "nexuspag", "wiinpay"] as const;
type GatewayAffiliateProvider = (typeof GATEWAY_AFFILIATE_PROVIDERS)[number];

function gatewayAffiliateConfigKey(provider: GatewayAffiliateProvider): string {
  return `GATEWAY_AFFILIATE_URL_${provider.toUpperCase()}`;
}

// GET /config/support-whatsapp — público e sem auth: o frontend usa isto pra
// montar o botão de suporte via WhatsApp, visível a QUALQUER usuário (não só
// admin). Ao contrário de /admin/config/:key (auth:true, chave genérica), este
// endpoint tem formato de resposta fixo e só devolve estas duas chaves — nunca
// abrir um `:key` genérico aqui, senão vaza qualquer config da platform_config.
export const getSupportWhatsappConfig = api(
  { method: "GET", path: "/config/support-whatsapp", expose: true },
  async (): Promise<{ phone: string | null; message: string | null }> => {
    const rows = await db.select({ key: platformConfig.key, value: platformConfig.value })
      .from(platformConfig)
      .where(inArray(platformConfig.key, [WHATSAPP_SUPPORT_PHONE_KEY, WHATSAPP_SUPPORT_MESSAGE_KEY]));

    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return {
      phone:   byKey.get(WHATSAPP_SUPPORT_PHONE_KEY) ?? null,
      message: byKey.get(WHATSAPP_SUPPORT_MESSAGE_KEY) ?? null,
    };
  },
);

// GET /gateways/affiliate-links — auth:true (qualquer usuário logado, não só
// admin), pra aba /gateways do usuário comum montar os botões de convite com
// os links de afiliado configurados pelo admin em vez dos links institucionais
// fixos dos provedores. Mesmo cuidado do endpoint acima: resposta de formato
// fixo, whitelist explícita dos 4 providers conhecidos — nunca abrir um `:key`
// genérico aqui, senão vaza qualquer config da platform_config (ex.:
// REFERRAL_COMMISSION_PERCENT, USER_SPLIT_FEE_CENTS_*).
export const getGatewayAffiliateLinks = api(
  { method: "GET", path: "/gateways/affiliate-links", expose: true, auth: true },
  async (): Promise<{ links: Record<GatewayAffiliateProvider, string | null> }> => {
    const configKeys = GATEWAY_AFFILIATE_PROVIDERS.map(gatewayAffiliateConfigKey);
    const rows = await db.select({ key: platformConfig.key, value: platformConfig.value })
      .from(platformConfig)
      .where(inArray(platformConfig.key, configKeys));

    const byConfigKey = new Map(rows.map((r) => [r.key, r.value]));
    const links = Object.fromEntries(
      GATEWAY_AFFILIATE_PROVIDERS.map((provider) => [
        provider,
        byConfigKey.get(gatewayAffiliateConfigKey(provider)) ?? null,
      ]),
    ) as Record<GatewayAffiliateProvider, string | null>;

    return { links };
  },
);
