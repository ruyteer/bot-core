import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { ProfileDrizzleRepository } from "./infrastructure/profile.drizzle.repository.js";
import { GetProfileUseCase } from "./application/use-cases/get-profile.use-case.js";
import { db } from "../shared/database.js";
import { payments, bots, profiles } from "../shared/schema/index.js";
import { eq, and, inArray, sql } from "drizzle-orm";

const repo       = new ProfileDrizzleRepository();
const getProfile = new GetProfileUseCase(repo);

interface MeResponse {
  id:        string;
  email:     string;
  name:      string;
  isAdmin:   boolean;
  isBlocked: boolean;
  roles:     string[];
}

// ─── Revenue & Level ─────────────────────────────────────────────────────────

const REVENUE_LEVELS = [
  { floor: 0,       goal: 10_000 },
  { floor: 10_000,  goal: 50_000 },
  { floor: 50_000,  goal: 200_000 },
  { floor: 200_000, goal: 500_000 },
  { floor: 500_000, goal: 500_000 }, // MAX (level 5)
];

// GET /auth/revenue
export const revenue = api(
  { method: "GET", path: "/auth/revenue", expose: true, auth: true },
  async (): Promise<{ totalRevenue: number; level: number; currentFloor: number; nextGoal: number; progressPct: number }> => {
    const { userID: userId } = getAuthData()!;

    const userBots = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
    const botIds   = userBots.map((b) => b.id);

    let totalCents = 0;
    if (botIds.length > 0) {
      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)` })
        .from(payments)
        .where(and(inArray(payments.botId, botIds), sql`${payments.status} = 'paid'`));
      totalCents = Number(row?.total ?? 0);
    }

    const totalRevenue = totalCents / 100; // centavos → reais

    let level = 1;
    for (let i = REVENUE_LEVELS.length - 1; i >= 0; i--) {
      if (totalRevenue >= REVENUE_LEVELS[i].floor) { level = i + 1; break; }
    }

    const tier = REVENUE_LEVELS[level - 1];
    const isMax = level >= REVENUE_LEVELS.length;
    const progressPct = isMax
      ? 100
      : Math.min(100, ((totalRevenue - tier.floor) / (tier.goal - tier.floor)) * 100);

    return {
      totalRevenue,
      level,
      currentFloor: tier.floor,
      nextGoal:     tier.goal,
      progressPct,
    };
  },
);

// PATCH /auth/profile — update user profile name
export const updateProfile = api(
  { method: "PATCH", path: "/auth/profile", expose: true, auth: true },
  async ({ name }: { name: string }): Promise<MeResponse> => {
    const { userID: userId } = getAuthData()!;
    await db.update(profiles).set({ name, updatedAt: new Date() }).where(eq(profiles.id, userId));
    const profile = await getProfile.execute(userId);
    return {
      id:        profile.id,
      email:     profile.email,
      name:      profile.name,
      isAdmin:   profile.isAdmin,
      isBlocked: profile.isBlocked,
      roles:     profile.roles,
    };
  },
);

// GET /auth/me — substitui supabase.rpc("has_role") + supabase.from("profiles")
export const me = api(
  { method: "GET", path: "/auth/me", expose: true, auth: true },
  async (): Promise<MeResponse> => {
    const { userID: userId } = getAuthData()!;
    const profile = await getProfile.execute(userId);
    return {
      id:        profile.id,
      email:     profile.email,
      name:      profile.name,
      isAdmin:   profile.isAdmin,
      isBlocked: profile.isBlocked,
      roles:     profile.roles,
    };
  },
);
