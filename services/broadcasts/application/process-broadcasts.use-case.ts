import { eq, and, inArray, lte, lt, gt } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  scheduledMessages, broadcastRuns, bots, leads, payments, botGroups, funnelOffers,
} from "../../shared/schema/index.js";
import { TelegramClient } from "../../runner/application/telegram.client.js";
import { decrypt } from "../../shared/crypto.js";
import { telegramButtonStyle } from "../../runner/application/telegram-button-style.js";

// ── Variáveis do broadcast (chave simples, igual ao painel) ─────────────────────
function replaceVars(text: string, lead: { firstName?: string | null; lastName?: string | null; telegramUsername?: string | null }): string {
  return (text || "")
    .replace(/\{nome\}/gi, lead.firstName ?? "")
    .replace(/\{sobrenome\}/gi, lead.lastName ?? "")
    .replace(/\{username\}/gi, lead.telegramUsername ? `@${lead.telegramUsername}` : "");
}

// ── Recorrência (porte fiel do backend antigo: wall-clock em timezone IANA) ─────
type RecurrenceFreq = "daily" | "weekly" | "monthly";
interface RecurrenceRule { freq: RecurrenceFreq; weekdays?: number[]; day_of_month?: number; time: string; tz?: string }
export const DEFAULT_TZ = "America/Sao_Paulo";

export function partsInTz(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") map[p.type] = p.value;
  const wd: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +map.year, mo: +map.month - 1, d: +map.day, h: +map.hour % 24, mi: +map.minute, s: +map.second, wd: wd[map.weekday] ?? 0 };
}
// `s` (segundos) é opcional e só usado pelo parser de ingestão em broadcasts.api.ts —
// chamadas existentes de recorrência abaixo não passam esse argumento (default 0), então o
// cálculo de próxima ocorrência permanece inalterado.
export function zonedWallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string, s: number = 0): Date {
  let guess = Date.UTC(y, mo, d, h, mi, s, 0);
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(new Date(guess), tz);
    const localAsUtc = Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s);
    guess = Date.UTC(y, mo, d, h, mi, s, 0) - (localAsUtc - guess);
  }
  return new Date(guess);
}
function nextOccurrence(rule: RecurrenceRule, from: Date): Date | null {
  const tz = rule.tz || DEFAULT_TZ;
  const [hh, mm] = (rule.time || "09:00").split(":").map((n) => Number(n) || 0);
  const fp = partsInTz(from, tz);
  if (rule.freq === "daily") {
    let c = zonedWallTimeToUtc(fp.y, fp.mo, fp.d, hh, mm, tz);
    if (c <= from) { const tp = partsInTz(new Date(from.getTime() + 864e5), tz); c = zonedWallTimeToUtc(tp.y, tp.mo, tp.d, hh, mm, tz); }
    return c;
  }
  if (rule.freq === "weekly") {
    const days = (rule.weekdays && rule.weekdays.length) ? rule.weekdays : [fp.wd];
    for (let i = 0; i < 14; i++) { const dp = partsInTz(new Date(from.getTime() + i * 864e5), tz); const c = zonedWallTimeToUtc(dp.y, dp.mo, dp.d, hh, mm, tz); if (c > from && days.includes(dp.wd)) return c; }
    return null;
  }
  const dom = Math.min(Math.max(rule.day_of_month || 1, 1), 31);
  for (let i = 0; i < 3; i++) { const mo = fp.mo + i; const y = fp.y + Math.floor(mo / 12); const moN = ((mo % 12) + 12) % 12; const last = new Date(Date.UTC(y, moN + 1, 0)).getUTCDate(); const c = zonedWallTimeToUtc(y, moN, Math.min(dom, last), hh, mm, tz); if (c > from) return c; }
  return null;
}

// ── Audiência ───────────────────────────────────────────────────────────────────
type LeadRow = typeof leads.$inferSelect;
async function getAudienceLeads(botId: string, filterType: string, filterProductId?: string | null): Promise<LeadRow[]> {
  // Exclui chats de grupo/canal (id negativo) — só usuários reais recebem broadcast.
  const all = await db.select().from(leads).where(and(eq(leads.botId, botId), gt(leads.telegramChatId, 0n)));
  if (filterType === "all" || !filterType) return all;
  const paid = await db.select({ leadId: payments.leadId }).from(payments).where(and(eq(payments.botId, botId), eq(payments.status, "paid")));
  const buyerIds = new Set(paid.map((p) => p.leadId).filter(Boolean) as string[]);
  if (filterType === "buyers") return all.filter((l) => buyerIds.has(l.id));
  if (filterType === "non_buyers") return all.filter((l) => !buyerIds.has(l.id));
  if (filterType === "product" && filterProductId) {
    const prodPaid = await db.select({ leadId: payments.leadId }).from(payments).where(and(eq(payments.botId, botId), eq(payments.status, "paid"), eq(payments.offerId, filterProductId)));
    const ids = new Set(prodPaid.map((p) => p.leadId).filter(Boolean) as string[]);
    return all.filter((l) => ids.has(l.id));
  }
  return all;
}

interface MediaItem { url: string; media_type: string; has_spoiler?: boolean }

function buildKeyboard(buttons: Array<Record<string, unknown>>): { inline_keyboard: unknown[][] } | undefined {
  const rows = (buttons || []).filter((b) => b && (b.text || b.label)).map((b) => {
    const text = String(b.text ?? b.label ?? "");
    const style = telegramButtonStyle(b.style);
    if (b.url) return [{ text, url: String(b.url), ...(style ? { style } : {}) }];
    return [{ text, callback_data: String(b.callback ?? b.value ?? "noop"), ...(style ? { style } : {}) }];
  });
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// Resolve botões de OFERTA (funnel_offers) do broadcast → botão "comprar" com
// callback bcast_buy_<id>, tratado pelo runner. price em centavos (exibe /100).
async function resolveOfferButtons(botId: string, offers: Array<{ product_id?: string; external_ref?: string; button_text?: string; style?: unknown }>): Promise<Array<Array<Record<string, unknown>>>> {
  if (!offers || offers.length === 0) return [];
  const refs = offers.map((o) => o.external_ref).filter(Boolean) as string[];
  const ids = offers.map((o) => o.product_id).filter(Boolean) as string[];
  const products: Array<typeof funnelOffers.$inferSelect> = [];
  if (refs.length) products.push(...await db.select().from(funnelOffers).where(and(eq(funnelOffers.botId, botId), inArray(funnelOffers.externalRef, refs))));
  if (ids.length)  products.push(...await db.select().from(funnelOffers).where(and(eq(funnelOffers.botId, botId), inArray(funnelOffers.id, ids))));
  const fmt = (cents: number) => (Number(cents) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const rows: Array<Array<Record<string, unknown>>> = [];
  for (const o of offers) {
    const p = products.find((pp) => (o.external_ref && pp.externalRef === o.external_ref) || (o.product_id && pp.id === o.product_id));
    if (!p) continue;
    const label = (o.button_text && o.button_text.trim()) ? o.button_text : `🛒 ${p.name} — ${fmt(p.price)}`;
    const style = telegramButtonStyle(o.style);
    rows.push([{ text: label, callback_data: `bcast_buy_${p.id}`, ...(style ? { style } : {}) }]);
  }
  return rows;
}

async function sendMedia(tg: TelegramClient, chatId: string, items: MediaItem[], caption: string | undefined, replyMarkup: unknown, protect: boolean): Promise<void> {
  const album = items.filter((m) => m.media_type === "image" || m.media_type === "photo" || m.media_type === "video");
  if (items.length >= 2 && album.length >= 2) {
    await tg.sendMediaGroup(chatId, album.map((m, i) => ({ type: m.media_type === "video" ? "video" as const : "photo" as const, media: m.url, caption: i === 0 ? caption : undefined, has_spoiler: !!m.has_spoiler })), protect);
    if (replyMarkup) await tg.sendMessage({ chatId, text: "👇", replyMarkup, protectContent: protect });
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    await tg.sendSingleMedia(chatId, { type: m.media_type, url: m.url, caption: i === 0 ? caption : undefined, hasSpoiler: !!m.has_spoiler, replyMarkup: i === 0 ? replyMarkup : undefined, protect });
  }
}

// ── Finaliza um schedule (recorrência → próxima; senão sent) ────────────────────
async function finalizeSchedule(msg: typeof scheduledMessages.$inferSelect, finalStatus: "sent" | "partial" | "failed"): Promise<void> {
  const now = new Date();
  const rule = (msg.recurrenceRule as RecurrenceRule | null) || null;
  if (!rule) { await db.update(scheduledMessages).set({ status: finalStatus, sentAt: now, updatedAt: now }).where(eq(scheduledMessages.id, msg.id)); return; }
  const newCount = (msg.recurrenceCount || 0) + 1;
  const max = msg.recurrenceMaxOccurrences;
  const endAt = msg.recurrenceEndAt ? new Date(msg.recurrenceEndAt) : null;
  const next = nextOccurrence(rule, now);
  const exhausted = !next || (max != null && newCount >= max) || (endAt && next > endAt);
  if (exhausted) await db.update(scheduledMessages).set({ status: "completed", sentAt: now, recurrenceCount: newCount, updatedAt: now }).where(eq(scheduledMessages.id, msg.id));
  else await db.update(scheduledMessages).set({ status: "pending", scheduledAt: next!, recurrenceCount: newCount, updatedAt: now }).where(eq(scheduledMessages.id, msg.id));
}

// ── Processa broadcasts vencidos (chamado pelo tick do runner) ──────────────────
export async function processDueBroadcasts(): Promise<number> {
  // Recupera travados em "sending" há >10min (processo morreu no meio).
  await db.update(scheduledMessages).set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(scheduledMessages.status, "sending"), lt(scheduledMessages.updatedAt, new Date(Date.now() - 10 * 60_000))));

  // Claim atômico: pega pendentes vencidos e marca "sending" (lock otimista) — evita envio duplicado.
  const candidates = await db.select({ id: scheduledMessages.id }).from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, "pending"), lte(scheduledMessages.scheduledAt, new Date()))).limit(5);
  if (candidates.length === 0) return 0;
  const claimed = await db.update(scheduledMessages).set({ status: "sending", updatedAt: new Date() })
    .where(and(inArray(scheduledMessages.id, candidates.map((c) => c.id)), eq(scheduledMessages.status, "pending")))
    .returning();

  let processed = 0;
  for (const msg of claimed) {
    let status: "sent" | "partial" | "failed" = "sent";
    try {
      const r = await sendBroadcast(msg);
      status = r.totalTargets === 0 ? "sent" : r.failedCount === 0 ? "sent" : r.sentCount > 0 ? "partial" : "failed";
    } catch (e) { console.error("[broadcast] envio falhou:", e); status = "failed"; }
    await finalizeSchedule(msg, status).catch((e) => console.error("[broadcast] finalize falhou:", e));
    processed++;
  }
  return processed;
}

async function sendBroadcast(msg: typeof scheduledMessages.$inferSelect): Promise<{ totalTargets: number; sentCount: number; failedCount: number }> {
  const adv = (msg.advancedFilters && typeof msg.advancedFilters === "object" ? msg.advancedFilters : {}) as Record<string, unknown>;
  const media = (Array.isArray(adv.media) ? adv.media : []) as MediaItem[];
  const inlineButtons = (Array.isArray(adv.inline_buttons) ? adv.inline_buttons : []) as Array<Record<string, unknown>>;
  const offers = (Array.isArray(adv.offers) ? adv.offers : []) as Array<{ product_id?: string; external_ref?: string; button_text?: string; style?: unknown }>;
  const filterProductId = (adv.filter_product_id as string | null) ?? null;
  const targetType = msg.targetType || "leads";
  const targetGroupIds = (Array.isArray(msg.targetGroupIds) ? msg.targetGroupIds : []) as string[];
  const botIdList = (Array.isArray(msg.botIds) && msg.botIds.length ? msg.botIds : [msg.botId]).map(String);

  const botRows = await db.select().from(bots).where(inArray(bots.id, botIdList));
  let totalTargets = 0, sentCount = 0, failedCount = 0;

  for (const bot of botRows) {
    const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const inlineKb = buildKeyboard(inlineButtons);
    const offerRows = await resolveOfferButtons(bot.id, offers);
    const allRows = [...((inlineKb?.inline_keyboard as Array<Array<Record<string, unknown>>>) ?? []), ...offerRows];
    const keyboard = allRows.length ? { inline_keyboard: allRows } : undefined;

    // Leads
    if (targetType === "leads" || targetType === "both") {
      const audience = await getAudienceLeads(bot.id, msg.filterType || "all", filterProductId);
      for (const lead of audience) {
        const chatId = lead.telegramChatId.toString();
        const text = replaceVars(msg.message || "", lead);
        if (media.length === 0 && !text && !keyboard) continue; // nada a enviar
        totalTargets++;
        try {
          if (media.length > 0) await sendMedia(tg, chatId, media, text || undefined, keyboard, bot.protectContent);
          else await tg.sendMessage({ chatId, text: text || "👇", replyMarkup: keyboard, protectContent: bot.protectContent });
          sentCount++;
        } catch (e) { failedCount++; console.error("[broadcast] lead falhou:", lead.id, e); }
      }
    }

    // Grupos/canais
    if (targetType === "groups" || targetType === "both") {
      const groups = targetGroupIds.length
        ? await db.select().from(botGroups).where(and(eq(botGroups.botId, bot.id), inArray(botGroups.id, targetGroupIds)))
        : await db.select().from(botGroups).where(eq(botGroups.botId, bot.id));
      for (const g of groups) {
        const chatId = g.telegramChatId.toString();
        const text = msg.message || "";
        if (media.length === 0 && !text) continue;
        totalTargets++;
        try {
          if (media.length > 0) await sendMedia(tg, chatId, media, text || undefined, keyboard, bot.protectContent);
          else await tg.sendMessage({ chatId, text, replyMarkup: keyboard, protectContent: bot.protectContent });
          sentCount++;
        } catch (e) { failedCount++; console.error("[broadcast] grupo falhou:", g.id, e); }
      }
    }
  }

  await db.insert(broadcastRuns).values({
    userId: msg.userId, botId: msg.botId, botIds: botIdList,
    scheduledMessageId: msg.id, broadcastType: msg.broadcastType, filterType: msg.filterType, targetType: msg.targetType,
    status: failedCount === 0 ? "completed" : (sentCount > 0 ? "partial" : "failed"),
    totalTargets, sentCount, failedCount, finishedAt: new Date(), source: "scheduler", triggerKind: "broadcast",
  }).catch((e) => console.error("[broadcast] broadcast_run insert falhou:", e));

  return { totalTargets, sentCount, failedCount };
}
