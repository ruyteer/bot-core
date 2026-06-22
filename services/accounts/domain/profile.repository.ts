import type { Profile, ProfileWithRoles, UpsertProfileInput } from "./profile.entity.js";

export interface ProfileRepository {
  upsert(input: UpsertProfileInput): Promise<Profile>;
  findById(id: string): Promise<ProfileWithRoles | null>;
}
