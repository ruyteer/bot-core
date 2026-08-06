import { eq, and, inArray, sql, gte, lte } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { leads, leadProgress, leadMessages, funnels, funnelNodes, payments, bots, leadEvents } from "../../shared/schema/index.js";
import type { LeadRepository } from "../domain/lead.repository.js";
import type { Lead, LeadWithStats, LeadMessage, UpsertLeadInput } from "../domain/lead.entity.js";

export class LeadDrizzleRepository implements LeadRepository {
  private toLead(row: typeof leads.$inferSelect): Lead {
    return {
      id:               row.id,
      botId:            row.botId,
      telegramChatId:   row.telegramChatId as bigint,
      telegramUsername: row.telegramUsername,
      firstName:        row.firstName,
      lastName:         row.lastName,
      utmSource:        row.utmSource,
      utmMedium:        row.utmMedium,
      utmCampaign:      row.utmCampaign,
      createdAt:        row.createdAt,
      updatedAt:        row.updatedAt,
    };
  }

  async findByBotIds(botIds: string[], startDate?: Date, endDate?: Date): Promise<LeadWithStats[]> {
    if (botIds.length === 0) return [];

    const conditions = [inArray(leads.botId, botIds)];
    if (startDate) conditions.push(gte(leads.createdAt, startDate));
    if (endDate)   conditions.push(lte(leads.createdAt, endDate));
    const rows = await db.select().from(leads).where(and(...conditions));
    if (rows.length === 0) return [];

    const leadIds = rows.map((r) => r.id);

    // Fetch progress with funnel name
    const progressRows = await db
      .select({
        id:            leadProgress.id,
        leadId:        leadProgress.leadId,
        funnelId:      leadProgress.funnelId,
        funnelName:    funnels.name,
        currentNodeId: leadProgress.currentNodeId,
        status:        leadProgress.status,
      })
      .from(leadProgress)
      .leftJoin(funnels, eq(leadProgress.funnelId, funnels.id))
      .where(inArray(leadProgress.leadId, leadIds));

    // Fetch node summaries
    const nodeIds = progressRows.map((p) => p.currentNodeId).filter(Boolean) as string[];
    const nodeMap = new Map<string, string>();
    if (nodeIds.length > 0) {
      const nodeRows = await db.select({ id: funnelNodes.id, type: funnelNodes.type, content: funnelNodes.content })
        .from(funnelNodes).where(inArray(funnelNodes.id, nodeIds));
      for (const n of nodeRows) {
        const c = n.content as Record<string, unknown>;
        let summary: string = n.type as string;
        if (n.type === "trigger" && typeof c.command === "string") summary = `Gatilho: ${c.command}`;
        else if (n.type === "offer") {
          const offers = (c.offers as Array<{ product_name?: string }>) ?? [];
          if (offers[0]?.product_name) summary = `Oferta: ${offers[0].product_name}`;
        } else if (n.type === "message") {
          const blocks = (c.blocks as Array<{ type: string; content?: string }>) ?? [];
          const text = blocks.find((b) => b.type === "text" && b.content);
          if (text?.content) {
            const t = text.content as string;
            summary = t.length > 30 ? t.slice(0, 30) + "…" : t;
          }
        }
        nodeMap.set(n.id, summary);
      }
    }

    // Fetch first paid order per lead
    const paymentRows = await db
      .select({ leadId: payments.leadId, createdAt: payments.createdAt })
      .from(payments)
      .where(and(inArray(payments.leadId, leadIds), sql`${payments.status} IN ('paid','approved')`));
    const firstPayMap = new Map<string, Date>();
    for (const p of paymentRows) {
      if (p.leadId && !firstPayMap.has(p.leadId)) firstPayMap.set(p.leadId, p.createdAt);
    }

    // Fetch bot names
    const botRows = await db.select({ id: bots.id, name: bots.name })
      .from(bots).where(inArray(bots.id, botIds));
    const botNameMap = new Map(botRows.map((b) => [b.id, b.name]));

    // Build progress map (prefer progress with currentNodeId)
    const progressMap = new Map<string, typeof progressRows[0]>();
    for (const p of progressRows) {
      const existing = progressMap.get(p.leadId);
      if (!existing || p.currentNodeId) progressMap.set(p.leadId, p);
    }

    return rows.map((r) => {
      const lead = this.toLead(r);
      const prog = progressMap.get(r.id);
      const firstPay = firstPayMap.get(r.id);
      return {
        ...lead,
        botName: botNameMap.get(r.botId) ?? null,
        conversionTimeMs: firstPay ? firstPay.getTime() - r.createdAt.getTime() : null,
        progress: prog
          ? {
              id:            prog.id,
              leadId:        prog.leadId,
              funnelId:      prog.funnelId,
              funnelName:    prog.funnelName ?? null,
              currentNodeId: prog.currentNodeId,
              nodeSummary:   prog.currentNodeId ? (nodeMap.get(prog.currentNodeId) ?? null) : null,
              status:        prog.status,
            }
          : null,
      };
    });
  }

  async findById(id: string): Promise<LeadWithStats | null> {
    const [row] = await db.select().from(leads).where(eq(leads.id, id));
    if (!row) return null;
    const result = await this.findByBotIds([row.botId]);
    return result.find((l) => l.id === id) ?? null;
  }

  // Métricas de topo de funil. `starts` e `activeLeads` vêm de lead_events
  // (uma linha por /start); `newLeads` da própria tabela leads (primeiro
  // contato). Antes o painel derivava tudo de `leads`, onde só existe uma linha
  // por chat — daí "starts por lead" ser sempre 1,00.
  async getStats(botIds: string[], startDate?: Date, endDate?: Date): Promise<{ starts: number; activeLeads: number; newLeads: number }> {
    if (botIds.length === 0) return { starts: 0, activeLeads: 0, newLeads: 0 };

    const evConditions = [inArray(leadEvents.botId, botIds), eq(leadEvents.kind, "start")];
    if (startDate) evConditions.push(gte(leadEvents.createdAt, startDate));
    if (endDate)   evConditions.push(lte(leadEvents.createdAt, endDate));

    const [ev] = await db.select({
      starts:      sql<number>`count(*)::int`,
      activeLeads: sql<number>`count(distinct ${leadEvents.leadId})::int`,
    }).from(leadEvents).where(and(...evConditions));

    const leadConditions = [inArray(leads.botId, botIds)];
    if (startDate) leadConditions.push(gte(leads.createdAt, startDate));
    if (endDate)   leadConditions.push(lte(leads.createdAt, endDate));
    const [nl] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(and(...leadConditions));

    return {
      starts:      Number(ev?.starts ?? 0),
      activeLeads: Number(ev?.activeLeads ?? 0),
      newLeads:    Number(nl?.n ?? 0),
    };
  }

  async findByTelegramChatId(botId: string, telegramChatId: bigint): Promise<Lead | null> {
    const [row] = await db.select().from(leads)
      .where(and(eq(leads.botId, botId), eq(leads.telegramChatId, telegramChatId)));
    return row ? this.toLead(row) : null;
  }

  async upsert(input: UpsertLeadInput): Promise<Lead> {
    const [row] = await db.insert(leads).values({
      botId:            input.botId,
      telegramChatId:   input.telegramChatId,
      telegramUsername: input.telegramUsername,
      firstName:        input.firstName,
      lastName:         input.lastName,
      utmSource:        input.utmSource ?? null,
      utmCampaign:      input.utmCampaign ?? null,
    }).onConflictDoUpdate({
      target:  [leads.botId, leads.telegramChatId],
      set: {
        telegramUsername: input.telegramUsername,
        firstName:        input.firstName,
        lastName:         input.lastName,
        updatedAt:        new Date(),
      },
    }).returning();
    return this.toLead(row);
  }

  async getMessages(leadId: string, limit = 100): Promise<LeadMessage[]> {
    const rows = await db.select().from(leadMessages)
      .where(eq(leadMessages.leadId, leadId))
      .orderBy(leadMessages.createdAt)
      .limit(limit);
    return rows.map((r) => ({
      id:        r.id,
      direction: r.direction,
      content:   (r.content as Record<string, unknown>) ?? {},
      createdAt: r.createdAt,
    }));
  }

  async saveMessage(leadId: string, botId: string, direction: "inbound" | "outbound", content: Record<string, unknown>): Promise<LeadMessage> {
    const [row] = await db.insert(leadMessages).values({ leadId, botId, direction, content }).returning();
    return {
      id:        row.id,
      direction: row.direction,
      content:   (row.content as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
    };
  }

  async setPaused(leadId: string, paused: boolean): Promise<void> {
    await db.update(leadProgress)
      .set({ status: paused ? "paused_manual" : "active", updatedAt: new Date() })
      .where(eq(leadProgress.leadId, leadId));
  }

  async isLeadPaused(leadId: string): Promise<boolean> {
    const rows = await db.select({ status: leadProgress.status })
      .from(leadProgress).where(eq(leadProgress.leadId, leadId));
    return rows.some((r) => r.status === "paused_manual");
  }

  async getUserBotIds(userId: string): Promise<string[]> {
    const rows = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
    return rows.map((r) => r.id);
  }
}
