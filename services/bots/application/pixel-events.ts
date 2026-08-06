// Envio SERVER-SIDE de eventos de conversão para as plataformas de ads.
// O OrionBot não tem página web no fluxo do lead (tudo acontece no Telegram),
// então pixel de navegador é impossível — todo evento sai daqui, via Events
// API de cada rede: Meta CAPI, TikTok Events API v1.3 e Kwai S2S (adsnebula).
//
// Fila: conversion_events (status pending → sending → sent|failed), processada
// pelo tick lento do runner. O painel (BotSettings → cards de Pixel) lê o log
// com httpStatus/erro de cada envio.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  conversionEvents, trackingPixels, leads, payments,
  type Lead, type Payment,
} from "../../shared/schema/index.js";
import { decrypt } from "../../shared/crypto.js";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

// URL exibida como origem do evento (as Events APIs pedem uma URL de página).
const EVENT_SOURCE_URL = "https://orionbot.io/r";

// ── Enfileiramento ────────────────────────────────────────────────────────────

export type CanonicalEvent = "Lead" | "Purchase" | "PageView";

/** Cria um conversion_event pendente por pixel ATIVO do bot. Nunca lança. */
export async function enqueuePixelEvents(
  botId: string,
  eventName: CanonicalEvent,
  opts: { leadId?: string | null; paymentId?: string | null } = {},
): Promise<number> {
  try {
    const pixels = await db.select().from(trackingPixels)
      .where(and(eq(trackingPixels.botId, botId), eq(trackingPixels.isActive, true)));
    if (pixels.length === 0) return 0;

    await db.insert(conversionEvents).values(pixels.map((p) => ({
      botId,
      provider:  p.provider,
      eventName,
      eventId:   crypto.randomUUID(),
      status:    "pending",
      leadId:    opts.leadId ?? null,
      paymentId: opts.paymentId ?? null,
    })));
    return pixels.length;
  } catch (err) {
    console.error("[pixels] enfileirar eventos falhou:", err);
    return 0;
  }
}

// ── Senders por provider ──────────────────────────────────────────────────────

interface SendContext {
  pixelId:     string;
  accessToken: string | null;
  eventName:   CanonicalEvent;
  eventId:     string;
  lead:        Lead | null;
  payment:     Payment | null;
}

interface SendResult {
  ok:          boolean;
  httpStatus:  number | null;
  requestPayload: unknown;
  responseBody:   unknown;
  errorMessage?:  string;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* corpo não-JSON */ }
  return { status: res.status, json };
}

// Meta CAPI — https://graph.facebook.com/v21.0/<pixel>/events
async function sendMeta(ctx: SendContext): Promise<SendResult> {
  if (!ctx.accessToken) return { ok: false, httpStatus: null, requestPayload: null, responseBody: null, errorMessage: "pixel sem access token da CAPI" };

  const event: Record<string, unknown> = {
    event_name:  ctx.eventName,   // Lead | Purchase | PageView — nomes padrão da Meta
    event_time:  Math.floor(Date.now() / 1000),
    event_id:    ctx.eventId,
    action_source: "website",
    event_source_url: EVENT_SOURCE_URL,
    user_data: {
      // A CAPI exige ≥1 identificador; evento de teste (sem lead) usa o event_id.
      external_id: [sha256(ctx.lead ? ctx.lead.telegramChatId.toString() : ctx.eventId)],
      ...(ctx.lead?.clientIp        ? { client_ip_address: ctx.lead.clientIp } : {}),
      ...(ctx.lead?.clientUserAgent ? { client_user_agent: ctx.lead.clientUserAgent } : {}),
      ...(ctx.lead?.fbc ? { fbc: ctx.lead.fbc } : {}),
      ...(ctx.lead?.fbp ? { fbp: ctx.lead.fbp } : {}),
    },
    ...(ctx.payment ? {
      custom_data: {
        currency: "BRL",
        value: (ctx.payment.finalAmount ?? ctx.payment.amount) / 100,
      },
    } : {}),
  };

  const payload = { data: [event], access_token: ctx.accessToken };
  const { status, json } = await post(`https://graph.facebook.com/v21.0/${ctx.pixelId}/events`, payload);
  const ok = status >= 200 && status < 300 && !(json as { error?: unknown })?.error;
  return {
    ok, httpStatus: status,
    requestPayload: { ...payload, access_token: "***" },
    responseBody: json,
    ...(ok ? {} : { errorMessage: JSON.stringify((json as { error?: unknown })?.error ?? json).slice(0, 500) }),
  };
}

// TikTok Events API v1.3 — https://business-api.tiktok.com/open_api/v1.3/event/track/
const TIKTOK_EVENT: Record<CanonicalEvent, string> = {
  Lead:     "ViewContent",
  PageView: "ViewContent",
  Purchase: "CompletePayment",
};

async function sendTikTok(ctx: SendContext): Promise<SendResult> {
  if (!ctx.accessToken) return { ok: false, httpStatus: null, requestPayload: null, responseBody: null, errorMessage: "pixel sem access token da Events API" };

  const payload = {
    event_source:    "web",
    event_source_id: ctx.pixelId,
    data: [{
      event:      TIKTOK_EVENT[ctx.eventName],
      event_time: Math.floor(Date.now() / 1000),
      event_id:   ctx.eventId,
      user: {
        ...(ctx.lead?.ttclid ? { ttclid: ctx.lead.ttclid } : {}),
        external_id: sha256(ctx.lead ? ctx.lead.telegramChatId.toString() : ctx.eventId),
        ...(ctx.lead?.clientIp        ? { ip: ctx.lead.clientIp } : {}),
        ...(ctx.lead?.clientUserAgent ? { user_agent: ctx.lead.clientUserAgent } : {}),
      },
      page: { url: EVENT_SOURCE_URL },
      ...(ctx.payment ? {
        properties: {
          currency: "BRL",
          value: (ctx.payment.finalAmount ?? ctx.payment.amount) / 100,
        },
      } : {}),
    }],
  };

  const { status, json } = await post(
    "https://business-api.tiktok.com/open_api/v1.3/event/track/",
    payload,
    { "Access-Token": ctx.accessToken },
  );
  // A API responde 200 mesmo em erro lógico — sucesso é code === 0.
  const code = (json as { code?: number })?.code;
  const ok = status >= 200 && status < 300 && (code === 0 || code === undefined);
  return {
    ok, httpStatus: status, requestPayload: payload, responseBody: json,
    ...(ok ? {} : { errorMessage: JSON.stringify(json).slice(0, 500) }),
  };
}

// Kwai S2S — https://www.adsnebula.com/log/common/api (Kwai for Business LATAM)
const KWAI_EVENT: Record<CanonicalEvent, string> = {
  Lead:     "EVENT_CONTENT_VIEW",
  PageView: "EVENT_CONTENT_VIEW",
  Purchase: "EVENT_PURCHASE",
};

async function sendKwai(ctx: SendContext): Promise<SendResult> {
  if (!ctx.accessToken) return { ok: false, httpStatus: null, requestPayload: null, responseBody: null, errorMessage: "pixel sem access token do Kwai" };
  // O Kwai só atribui com o clickid do anúncio (capturado pelo /r). Sem ele,
  // não há o que enviar — registramos o motivo em vez de queimar a chamada.
  if (!ctx.lead?.kwaiClickId) {
    return { ok: false, httpStatus: null, requestPayload: null, responseBody: null, errorMessage: "lead sem clickid do Kwai (o link do anúncio precisa passar pelo /r com clickid=__CLICKID__)" };
  }

  const payload = {
    access_token: ctx.accessToken,
    clickid:      ctx.lead.kwaiClickId,
    event_name:   KWAI_EVENT[ctx.eventName],
    pixelId:      ctx.pixelId,
    testFlag:     false,
    trackFlag:    true,
    is_attributed: 1,
    mmpcode:      "PL",
    pixelSdkVersion: "9.9.9",
    third_party:  "kwai",
    ...(ctx.payment ? {
      properties: JSON.stringify({
        currency: "BRL",
        value: (ctx.payment.finalAmount ?? ctx.payment.amount) / 100,
      }),
    } : {}),
  };

  const { status, json } = await post("https://www.adsnebula.com/log/common/api", payload);
  const result = (json as { result?: number })?.result;
  const ok = status >= 200 && status < 300 && (result === 1 || result === undefined);
  return {
    ok, httpStatus: status,
    requestPayload: { ...payload, access_token: "***" },
    responseBody: json,
    ...(ok ? {} : { errorMessage: JSON.stringify(json).slice(0, 500) }),
  };
}

const SENDERS: Record<string, (ctx: SendContext) => Promise<SendResult>> = {
  facebook: sendMeta,
  meta:     sendMeta,
  tiktok:   sendTikTok,
  kwai:     sendKwai,
};

// ── Dispatcher (tick lento do runner) ─────────────────────────────────────────

/** Processa eventos pendentes. Claim atômico → sobreposição de ticks não duplica. */
export async function processPendingConversionEvents(limit = 25): Promise<number> {
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE conversion_events SET status = 'sending'
    WHERE id IN (
      SELECT id FROM conversion_events WHERE status = 'pending'
      ORDER BY created_at ASC LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  const ids = (claimed.rows ?? []).map((r) => r.id);
  if (ids.length === 0) return 0;

  let processed = 0;
  for (const id of ids) {
    const [ev] = await db.select().from(conversionEvents).where(eq(conversionEvents.id, id)).limit(1);
    if (!ev) continue;

    let result: SendResult;
    try {
      const [pixel] = await db.select().from(trackingPixels)
        .where(and(eq(trackingPixels.botId, ev.botId), eq(trackingPixels.provider, ev.provider)))
        .limit(1);

      if (!pixel || !pixel.isActive) {
        result = { ok: false, httpStatus: null, requestPayload: null, responseBody: null, errorMessage: "pixel removido ou inativo" };
      } else {
        const sender = SENDERS[ev.provider];
        if (!sender) {
          result = { ok: false, httpStatus: null, requestPayload: null, responseBody: null, errorMessage: `provider desconhecido: ${ev.provider}` };
        } else {
          const lead = ev.leadId
            ? (await db.select().from(leads).where(eq(leads.id, ev.leadId)).limit(1))[0] ?? null
            : null;
          const payment = ev.paymentId
            ? (await db.select().from(payments).where(eq(payments.id, ev.paymentId)).limit(1))[0] ?? null
            : null;

          result = await sender({
            pixelId:     pixel.pixelId,
            accessToken: pixel.accessToken ? decrypt(pixel.accessToken) : null,
            eventName:   (ev.eventName as CanonicalEvent) ?? "PageView",
            eventId:     ev.eventId ?? crypto.randomUUID(),
            lead,
            payment,
          });
        }
      }
    } catch (err) {
      result = {
        ok: false, httpStatus: null, requestPayload: null, responseBody: null,
        errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      };
    }

    await db.update(conversionEvents).set({
      status:         result.ok ? "sent" : "failed",
      httpStatus:     result.httpStatus,
      requestPayload: result.requestPayload ?? null,
      responseBody:   result.responseBody ?? null,
      errorMessage:   result.errorMessage ?? null,
    }).where(eq(conversionEvents.id, id));
    processed++;
  }
  return processed;
}
