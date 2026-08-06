import { eq, and, notInArray } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  funnels, funnelNodes, funnelOffers, bots,
  remarketingCampaigns, remarketingMessages, scheduledMessages, complianceAlerts,
} from "../../shared/schema/index.js";
import { ComplianceRepository } from "../infrastructure/compliance.repository.js";
import { scanText } from "./engine.js";

const repo = new ComplianceRepository();

export type SourceType = "funnel" | "offer" | "remarketing" | "broadcast" | "bot";

// Coleta recursivamente TODAS as strings de um valor jsonb (funil, config, etc.).
function collectStrings(v: unknown, out: string[]): void {
  if (v == null) return;
  if (typeof v === "string") { if (v.trim()) out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out); return; }
  if (typeof v === "object") { for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out); }
}

// Lê os textos + o dono de uma origem. Retorna null se a origem não existir mais.
async function loadSource(type: SourceType, id: string): Promise<{ texts: string[]; userId: string | null } | null> {
  const texts: string[] = [];

  if (type === "funnel") {
    const [f] = await db.select().from(funnels).where(eq(funnels.id, id));
    if (!f) return null;
    if (f.name) texts.push(f.name);
    collectStrings(f.simplifiedConfig, texts);
    const nodes = await db.select({ content: funnelNodes.content }).from(funnelNodes).where(eq(funnelNodes.funnelId, id));
    for (const n of nodes) collectStrings(n.content, texts);
    return { texts, userId: f.userId };
  }

  if (type === "offer") {
    const [o] = await db.select().from(funnelOffers).where(eq(funnelOffers.id, id));
    if (!o) return null;
    for (const t of [o.name, o.deliveryText, o.deliveryUrl]) if (t) texts.push(t);
    const [b] = o.botId ? await db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, o.botId)) : [];
    return { texts, userId: b?.userId ?? null };
  }

  if (type === "remarketing") {
    const [c] = await db.select().from(remarketingCampaigns).where(eq(remarketingCampaigns.id, id));
    if (!c) return null;
    if (c.name) texts.push(c.name);
    const msgs = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, id));
    for (const m of msgs) { if (m.message) texts.push(m.message); collectStrings(m.inlineButtons, texts); }
    const [b] = c.botId ? await db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, c.botId)) : [];
    return { texts, userId: b?.userId ?? null };
  }

  if (type === "broadcast") {
    const [s] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id));
    if (!s) return null;
    if (s.message) texts.push(s.message);
    collectStrings(s.advancedFilters, texts);
    return { texts, userId: s.userId ?? null };
  }

  // bot
  const [bt] = await db.select().from(bots).where(eq(bots.id, id));
  if (!bt) return null;
  if (bt.name) texts.push(bt.name);
  return { texts, userId: bt.userId };
}

/**
 * Escaneia UMA origem e persiste o alerta (idempotente). Nunca lança — compliance
 * é observabilidade e não pode derrubar a escrita que a disparou.
 */
export async function scanSource(type: SourceType, id: string): Promise<void> {
  try {
    const dict = await repo.loadDict();
    const src = await loadSource(type, id);
    if (!src) { await repo.deleteForSource(type, id); return; }
    // Sem dicionário → sem match → limpa pendente eventual.
    const matches = dict.length ? scanText(src.texts.join("\n"), dict) : [];
    await repo.applyScan(type, id, src.userId, matches);
  } catch (err) {
    console.error(`[compliance] scan ${type}/${id} falhou:`, err);
  }
}

// Fire-and-forget: usado pelos use-cases de escrita sem bloquear a resposta.
export function scanSourceAsync(type: SourceType, id: string): void {
  void scanSource(type, id);
}

/**
 * Re-escaneia TODAS as origens (usado ao mudar o dicionário ou no botão do admin).
 * Também remove alertas órfãos de origens que não existem mais.
 */
export async function rescanAll(): Promise<number> {
  const jobs: Array<[SourceType, string]> = [];
  const push = (t: SourceType, rows: Array<{ id: string }>) => rows.forEach((r) => jobs.push([t, r.id]));

  push("funnel",      await db.select({ id: funnels.id }).from(funnels));
  push("offer",       await db.select({ id: funnelOffers.id }).from(funnelOffers));
  push("remarketing", await db.select({ id: remarketingCampaigns.id }).from(remarketingCampaigns));
  push("broadcast",   await db.select({ id: scheduledMessages.id }).from(scheduledMessages));
  push("bot",         await db.select({ id: bots.id }).from(bots));

  // Poda alertas cujo source_id sumiu (origem apagada). `jobs` já contém os ids
  // vivos de cada tipo — apaga os alertas do tipo que não estão nessa lista.
  for (const type of ["funnel", "offer", "remarketing", "broadcast", "bot"] as SourceType[]) {
    const aliveIds = jobs.filter(([t]) => t === type).map(([, id]) => id);
    if (aliveIds.length === 0) {
      await db.delete(complianceAlerts).where(eq(complianceAlerts.sourceType, type));
    } else {
      await db.delete(complianceAlerts).where(and(
        eq(complianceAlerts.sourceType, type),
        notInArray(complianceAlerts.sourceId, aliveIds),
      ));
    }
  }

  for (const [t, id] of jobs) await scanSource(t, id);
  return jobs.length;
}
