import type { Profile, ProfileWithRoles, ProvisionProfileInput, ProvisionProfileResult, UpsertProfileInput } from "./profile.entity.js";

export interface ProfileRepository {
  upsert(input: UpsertProfileInput): Promise<Profile>;
  findById(id: string): Promise<ProfileWithRoles | null>;
  provision(input: ProvisionProfileInput): Promise<ProvisionProfileResult>;
}
