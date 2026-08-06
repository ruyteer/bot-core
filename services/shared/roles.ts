import { and, eq } from "drizzle-orm";
import { db } from "./database.js";
import { userRoles } from "./schema/index.js";

// True se o usuário é admin da plataforma. Admin não paga a taxa de split
// (gera PIX sem a fatia da plataforma). Falha silenciosa → trata como não-admin.
export async function isPlatformAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const [r] = await db.select({ role: userRoles.role }).from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.role, "admin"))).limit(1);
    return !!r;
  } catch {
    return false;
  }
}
