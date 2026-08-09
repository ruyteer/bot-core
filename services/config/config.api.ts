import { api } from "encore.dev/api";
import { inArray } from "drizzle-orm";
import { db } from "../shared/database.js";
import { platformConfig } from "../shared/schema/index.js";

const WHATSAPP_SUPPORT_PHONE_KEY   = "WHATSAPP_SUPPORT_PHONE";
const WHATSAPP_SUPPORT_MESSAGE_KEY = "WHATSAPP_SUPPORT_MESSAGE";

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
