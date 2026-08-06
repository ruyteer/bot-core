import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq } from "drizzle-orm";
import { db } from "../shared/database.js";
import { userRoles } from "../shared/schema/index.js";
import { ComplianceRepository, type AlertRow } from "./infrastructure/compliance.repository.js";
import { rescanAll } from "./application/scan.js";

const repo = new ComplianceRepository();

async function requireAdmin(userId: string) {
  const [role] = await db.select({ role: userRoles.role }).from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, "admin"))).limit(1);
  if (!role) throw APIError.permissionDenied("admin access required");
}

// ── Alertas ─────────────────────────────────────────────────────────────────

// GET /admin/compliance/alerts?status=pending|resolved|dismissed
export const listAlerts = api(
  { method: "GET", path: "/admin/compliance/alerts", expose: true, auth: true },
  async ({ status }: { status?: string }): Promise<{ alerts: AlertRow[] }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    return { alerts: await repo.listAlerts(status) };
  },
);

// GET /admin/compliance/pending-count — para o badge do sidebar
export const pendingCount = api(
  { method: "GET", path: "/admin/compliance/pending-count", expose: true, auth: true },
  async (): Promise<{ count: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    return { count: await repo.pendingCount() };
  },
);

export const resolveAlert = api(
  { method: "POST", path: "/admin/compliance/alerts/:id/resolve", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    await repo.resolve(id);
    return { ok: true };
  },
);

export const dismissAlert = api(
  { method: "POST", path: "/admin/compliance/alerts/:id/dismiss", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    await repo.dismiss(id);
    return { ok: true };
  },
);

export const reopenAlert = api(
  { method: "POST", path: "/admin/compliance/alerts/:id/reopen", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    await repo.reopen(id);
    return { ok: true };
  },
);

// ── Palavras (dicionário) ─────────────────────────────────────────────────────

interface KeywordItem { id: string; keyword: string; category: string; createdAt: string }

export const listKeywords = api(
  { method: "GET", path: "/admin/compliance/keywords", expose: true, auth: true },
  async (): Promise<{ keywords: KeywordItem[] }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    return { keywords: await repo.listKeywords() };
  },
);

// PUT /admin/compliance/keywords — substitui o dicionário inteiro (CRUD em massa).
// Cada item: { keyword, category? }. Re-escaneia tudo depois.
export const setKeywords = api(
  { method: "PUT", path: "/admin/compliance/keywords", expose: true, auth: true },
  async ({ keywords }: { keywords: Array<{ keyword: string; category?: string }> }): Promise<{ ok: boolean; count: number; scanned: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    const count = await repo.replaceKeywords(keywords);
    // Mudar o dicionário exige re-escanear todas as origens.
    const scanned = await rescanAll();
    return { ok: true, count, scanned };
  },
);

// POST /admin/compliance/rescan — força re-scan de tudo
export const rescan = api(
  { method: "POST", path: "/admin/compliance/rescan", expose: true, auth: true },
  async (): Promise<{ ok: boolean; scanned: number }> => {
    const { userID } = getAuthData()!;
    await requireAdmin(userID);
    return { ok: true, scanned: await rescanAll() };
  },
);
