import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { bots, leads, trackingClicks } from "../../shared/schema/index.js";

// ── Registro do clique (links de tráfego pago /r?b=...) ──────────────────────

export interface ClickParams {
  botId:       string;
  platform?:   string | null;
  utmSource?:  string | null;
  utmMedium?:  string | null;
  utmCampaign?:string | null;
  utmContent?: string | null;
  utmTerm?:    string | null;
  fbclid?:     string | null;
  gclid?:      string | null;
  ttclid?:     string | null;
  kwaiClickId?:string | null;
  clientIp?:   string | null;
  userAgent?:  string | null;
}

// Macro NÃO substituída pela plataforma (ex.: anúncio em rascunho, teste manual
// do link). Não vira UTM — senão o lead fica com utm_campaign="{{campaign.name}}".
function cleanParam(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (/^\{\{.*\}\}$/.test(s) || /^__.*__$/.test(s) || /^\{.*\}$/.test(s)) return null;
  return s.slice(0, 500);
}

/**
 * Grava o clique e devolve a URL do Telegram com o token no /start.
 * Substitui a Edge Function `tracking-redirect` do Supabase, que morreu na
 * migração — desde então o link de tráfego pago caía numa página de erro.
 */
export async function registerTrackingClick(params: ClickParams): Promise<{ url: string } | null> {
  const [bot] = await db.select({ username: bots.telegramUsername })
    .from(bots).where(eq(bots.id, params.botId)).limit(1);
  if (!bot?.username) return null;

  // 3 + 32 = 35 chars — dentro do limite de 64 do start payload do Telegram.
  const token = randomUUID().replace(/-/g, "");

  await db.insert(trackingClicks).values({
    botId:       params.botId,
    token,
    platform:    cleanParam(params.platform),
    utmSource:   cleanParam(params.utmSource),
    utmMedium:   cleanParam(params.utmMedium),
    utmCampaign: cleanParam(params.utmCampaign),
    utmContent:  cleanParam(params.utmContent),
    utmTerm:     cleanParam(params.utmTerm),
    fbclid:      cleanParam(params.fbclid),
    gclid:       cleanParam(params.gclid),
    ttclid:      cleanParam(params.ttclid),
    kwaiClickId: cleanParam(params.kwaiClickId),
    clientIp:    params.clientIp?.slice(0, 100) ?? null,
    userAgent:   params.userAgent?.slice(0, 500) ?? null,
  });

  return { url: `https://t.me/${bot.username}?start=tk_${token}` };
}

// ── Resolução no /start (chamada pelo runner) ────────────────────────────────

const ORGANIC_PREFIXES: Array<[string, "utmSource" | "utmMedium" | "utmCampaign" | "utmContent" | "utmTerm"]> = [
  ["src_", "utmSource"],
  ["m_",   "utmMedium"],
  ["c_",   "utmCampaign"],
  ["ct_",  "utmContent"],
  ["t_",   "utmTerm"],
];

/**
 * Aplica o payload do deep link ("/start <payload>") no lead:
 * - `tk_<token>`  → clique de tráfego pago salvo pelo /r (UTMs + click ids).
 * - `src_x__m_y`  → link orgânico com UTMs embutidas no próprio payload.
 * Nunca lança: rastreamento jamais pode derrubar o funil.
 */
export async function applyStartTracking(leadId: string, startPayload: string): Promise<void> {
  try {
    const payload = startPayload.trim();
    if (!payload) return;

    if (payload.startsWith("tk_")) {
      const token = payload.slice(3);
      const [click] = await db.select().from(trackingClicks)
        .where(eq(trackingClicks.token, token)).limit(1);
      if (!click) return;

      await db.update(leads).set({
        ...(click.utmSource   ? { utmSource:   click.utmSource }   : {}),
        ...(click.utmMedium   ? { utmMedium:   click.utmMedium }   : {}),
        ...(click.utmCampaign ? { utmCampaign: click.utmCampaign } : {}),
        ...(click.utmContent  ? { utmContent:  click.utmContent }  : {}),
        ...(click.utmTerm     ? { utmTerm:     click.utmTerm }     : {}),
        ...(click.fbclid      ? { fbclid:      click.fbclid }      : {}),
        // fbc no formato oficial (fb.1.<ts do clique>.<fbclid>) — é o que a
        // CAPI usa para atribuição; o timestamp real do clique está aqui.
        ...(click.fbclid      ? { fbc: `fb.1.${click.createdAt.getTime()}.${click.fbclid}` } : {}),
        ...(click.ttclid      ? { ttclid:      click.ttclid }      : {}),
        ...(click.kwaiClickId ? { kwaiClickId: click.kwaiClickId } : {}),
        ...(click.clientIp    ? { clientIp:    click.clientIp }    : {}),
        ...(click.userAgent   ? { clientUserAgent: click.userAgent } : {}),
        updatedAt: new Date(),
      }).where(eq(leads.id, leadId));

      // Liga clique → lead (funil de conversão do link) sem sobrescrever o
      // primeiro consumo caso o mesmo link seja clicado de novo.
      if (!click.consumedAt) {
        await db.update(trackingClicks)
          .set({ leadId, consumedAt: new Date() })
          .where(eq(trackingClicks.id, click.id));
      }
      return;
    }

    // Formato orgânico: segmentos separados por "__", cada um com prefixo.
    if (/^(src|m|c|ct|t)_/.test(payload)) {
      const set: Record<string, string> = {};
      for (const seg of payload.split("__")) {
        for (const [prefix, field] of ORGANIC_PREFIXES) {
          if (seg.startsWith(prefix) && seg.length > prefix.length) {
            set[field] = seg.slice(prefix.length).slice(0, 200);
            break;
          }
        }
      }
      if (Object.keys(set).length > 0) {
        await db.update(leads).set({ ...set, updatedAt: new Date() }).where(eq(leads.id, leadId));
      }
    }
  } catch (err) {
    console.error("[tracking] falha ao aplicar payload do /start:", err);
  }
}
