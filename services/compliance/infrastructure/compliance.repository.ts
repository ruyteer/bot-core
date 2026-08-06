import { and, eq, sql, desc } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { blockedKeywords, complianceAlerts } from "../../shared/schema/index.js";
import { scanText, type KeywordEntry, type Match } from "../application/engine.js";

export interface AlertRow {
  id:         string;
  sourceType: string;
  sourceId:   string;
  userId:     string | null;
  keywords:   string[];
  category:   string | null;
  snippet:    string | null;
  status:     string;
  createdAt:  string;
  updatedAt:  string;
}

const uniq = (a: string[]) => [...new Set(a)];

export class ComplianceRepository {
  // ── Dicionário ────────────────────────────────────────────────────────────
  async loadDict(): Promise<KeywordEntry[]> {
    const rows = await db.select({ keyword: blockedKeywords.keyword, category: blockedKeywords.category })
      .from(blockedKeywords);
    return rows;
  }

  async listKeywords(): Promise<Array<{ id: string; keyword: string; category: string; createdAt: string }>> {
    const rows = await db.select().from(blockedKeywords).orderBy(blockedKeywords.keyword);
    return rows.map((r) => ({ id: r.id, keyword: r.keyword, category: r.category, createdAt: r.createdAt.toISOString() }));
  }

  // Substitui o dicionário inteiro pelas linhas informadas (CRUD em massa da UI).
  // Cada item: "palavra" ou "palavra | categoria".
  async replaceKeywords(lines: Array<{ keyword: string; category?: string }>): Promise<number> {
    const clean = lines
      .map((l) => ({ keyword: l.keyword.trim(), category: (l.category || "geral").trim() || "geral" }))
      .filter((l) => l.keyword.length > 0);
    // dedup por keyword (case-insensitive)
    const seen = new Set<string>();
    const rows = clean.filter((l) => {
      const k = l.keyword.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    await db.transaction(async (tx) => {
      await tx.delete(blockedKeywords);
      if (rows.length > 0) await tx.insert(blockedKeywords).values(rows);
    });
    return rows.length;
  }

  async deleteKeyword(id: string): Promise<void> {
    await db.delete(blockedKeywords).where(eq(blockedKeywords.id, id));
  }

  // ── Alertas ───────────────────────────────────────────────────────────────

  private toRow(r: typeof complianceAlerts.$inferSelect): AlertRow {
    return {
      id: r.id, sourceType: r.sourceType, sourceId: r.sourceId, userId: r.userId,
      keywords: (r.keywords as string[]) ?? [], category: r.category, snippet: r.snippet,
      status: r.status, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
  }

  // Aplica o resultado de um scan a uma origem, de forma idempotente. Não duplica
  // e respeita as palavras já descartadas (dismissed) pelo admin para a origem.
  async applyScan(sourceType: string, sourceId: string, userId: string | null, matches: Match[]): Promise<void> {
    const [existing] = await db.select().from(complianceAlerts)
      .where(and(eq(complianceAlerts.sourceType, sourceType), eq(complianceAlerts.sourceId, sourceId)));

    if (matches.length === 0) {
      // Sem violação: remove alerta pendente (mantém histórico resolved/dismissed).
      if (existing && existing.status === "pending") {
        await db.delete(complianceAlerts).where(eq(complianceAlerts.id, existing.id));
      }
      return;
    }

    const dismissed = (existing?.dismissedKeywords as string[]) ?? [];
    const effective = matches.filter((m) => !dismissed.includes(m.keyword));
    if (effective.length === 0) {
      // Todas as palavras já foram descartadas antes — não recria.
      if (existing && existing.status === "pending") {
        await db.delete(complianceAlerts).where(eq(complianceAlerts.id, existing.id));
      }
      return;
    }

    const kws   = uniq(effective.map((m) => m.keyword));
    const first = effective[0];

    if (existing) {
      await db.update(complianceAlerts).set({
        keywords: kws, category: first.category, snippet: first.snippet,
        status: "pending", updatedAt: new Date(),
        // reabre com o conjunto atual; mantém dismissedKeywords para não perder o trap
      }).where(eq(complianceAlerts.id, existing.id));
    } else {
      await db.insert(complianceAlerts).values({
        sourceType, sourceId, userId, keywords: kws,
        category: first.category, snippet: first.snippet, status: "pending",
      }).onConflictDoNothing();
    }
  }

  // Chamado quando a origem é apagada — remove alertas órfãos.
  async deleteForSource(sourceType: string, sourceId: string): Promise<void> {
    await db.delete(complianceAlerts)
      .where(and(eq(complianceAlerts.sourceType, sourceType), eq(complianceAlerts.sourceId, sourceId)));
  }

  async listAlerts(status?: string): Promise<AlertRow[]> {
    const rows = status
      ? await db.select().from(complianceAlerts).where(eq(complianceAlerts.status, status)).orderBy(desc(complianceAlerts.updatedAt))
      : await db.select().from(complianceAlerts).orderBy(desc(complianceAlerts.updatedAt));
    return rows.map((r) => this.toRow(r));
  }

  async pendingCount(): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(complianceAlerts)
      .where(eq(complianceAlerts.status, "pending"));
    return Number(row?.n ?? 0);
  }

  async resolve(id: string): Promise<void> {
    await db.update(complianceAlerts).set({ status: "resolved", updatedAt: new Date() })
      .where(eq(complianceAlerts.id, id));
  }

  // Falso positivo: marca dismissed e grava as palavras para não recriar depois.
  async dismiss(id: string): Promise<void> {
    const [a] = await db.select().from(complianceAlerts).where(eq(complianceAlerts.id, id));
    if (!a) return;
    const dismissed = uniq([...((a.dismissedKeywords as string[]) ?? []), ...((a.keywords as string[]) ?? [])]);
    await db.update(complianceAlerts).set({ status: "dismissed", dismissedKeywords: dismissed, updatedAt: new Date() })
      .where(eq(complianceAlerts.id, id));
  }

  // Reabre: volta a pending e limpa o trap (as palavras voltam a alertar).
  async reopen(id: string): Promise<void> {
    await db.update(complianceAlerts).set({ status: "pending", dismissedKeywords: [], updatedAt: new Date() })
      .where(eq(complianceAlerts.id, id));
  }
}

// Helper puro reexportado para o orquestrador de scan.
export { scanText };
