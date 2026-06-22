import { eq } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { profiles, userRoles } from "../../shared/schema/index.js";
import type { Profile, ProfileWithRoles, UpsertProfileInput } from "../domain/profile.entity.js";
import type { ProfileRepository } from "../domain/profile.repository.js";

export class ProfileDrizzleRepository implements ProfileRepository {
  async upsert(input: UpsertProfileInput): Promise<Profile> {
    const [row] = await db
      .insert(profiles)
      .values({
        id:    input.id,
        email: input.email,
        name:  input.name,
      })
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          email:     input.email,
          name:      input.name,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async findById(id: string): Promise<ProfileWithRoles | null> {
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, id))
      .limit(1);

    if (!profile) return null;

    const roles = await db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, id));

    const roleList = roles.map((r) => r.role);
    return {
      ...profile,
      roles:   roleList,
      isAdmin: roleList.includes("admin"),
    };
  }
}
