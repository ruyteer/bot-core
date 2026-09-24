import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { bots, leads, trackingClicks } from "../../shared/schema/index.js";
import { allowClick } from "./click-rate-limiter.js";

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

  const ip = params.clientIp?.trim() || null;
  // Sem IP pra correlacionar (proxy que não repassa nada), não dá pra conter
  // replay sem arriscar throttle cruzado entre visitantes distintos — nesse
  // caso raro segue sem rate limit.
  if (ip && !allowClick(ip, params.botId)) {
    // Estourou o limite: o visitante real não pode ficar sem link funcional,
    // mas reaproveitar o MESMO token do último clique (comportamento antigo)
    // quebrava com o resgate atômico de uso único do /start — CGNAT, rede
    // corporativa e wifi público colocam facilmente mais de
    // MAX_CLICKS_PER_WINDOW visitantes DISTINTOS atrás do mesmo IP num
    // anúncio com tráfego alto, e só o primeiro deles ficava com a
    // atribuição; os demais perdiam em silêncio quando o token já tivesse
    // sido consumido (ver applyStartTracking). O limite existe pra conter
    // GRAVAÇÃO abusiva de parâmetros arbitrários (replay manipulando a query
    // string), não pra forçar visitantes distintos a compartilhar token —
    // clona as UTMs do último clique legítimo (gravado ainda dentro do
    // limite, então já validado) para um token NOVO, próprio de cada
    // visitante. Existe pelo menos um clique anterior, já que a janela só
    // bloqueia depois de MAX_CLICKS_PER_WINDOW cliques terem sido gravados.
    const [last] = await db.select().from(trackingClicks)
      .where(and(eq(trackingClicks.botId, params.botId), eq(trackingClicks.clientIp, ip.slice(0, 100))))
      .orderBy(desc(trackingClicks.createdAt))
      .limit(1);
    if (last) {
      const clonedToken = randomUUID().replace(/-/g, "");
      await db.insert(trackingClicks).values({
        botId:       params.botId,
        token:       clonedToken,
        platform:    last.platform,
        utmSource:   last.utmSource,
        utmMedium:   last.utmMedium,
        utmCampaign: last.utmCampaign,
        utmContent:  last.utmContent,
        utmTerm:     last.utmTerm,
        fbclid:      last.fbclid,
        gclid:       last.gclid,
        ttclid:      last.ttclid,
        kwaiClickId: last.kwaiClickId,
        clientIp:    last.clientIp,
        userAgent:   last.userAgent,
      });
      return { url: `https://t.me/${bot.username}?start=tk_${clonedToken}` };
    }
    // Sem clique anterior achado (não deveria acontecer): segue pro fluxo
    // normal abaixo em vez de travar o redirect do visitante real.
  }

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
export async function applyStartTracking(leadId: string, startPayload: string, botId: string): Promise<void> {
  try {
    const payload = startPayload.trim();
    if (!payload) return;

    if (payload.startsWith("tk_")) {
      const token = payload.slice(3);

      // Resgate atômico e de uso único, preso ao bot que emitiu o clique: o
      // UPDATE só afeta a linha se token+bot baterem E consumedAt ainda for
      // nulo, tudo numa única instrução — duas corridas concorrentes (mesmo
      // token, /start em paralelo) travam na mesma linha e só uma vence,
      // porque o WHERE é reavaliado depois do commit da primeira. Antes, o
      // mesmo tk_ podia ser resgatado em qualquer outro bot (a busca era só
      // por token, sem checar o dono) e quantas vezes quisessem (a UTM era
      // reaplicada a cada /start, mesmo já consumido).
      const [click] = await db.update(trackingClicks)
        .set({ leadId, consumedAt: new Date() })
        .where(and(
          eq(trackingClicks.token, token),
          eq(trackingClicks.botId, botId),
          isNull(trackingClicks.consumedAt),
        ))
        .returning();
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
