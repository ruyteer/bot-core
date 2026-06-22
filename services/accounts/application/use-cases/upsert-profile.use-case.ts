import type { Profile, UpsertProfileInput } from "../../domain/profile.entity.js";
import type { ProfileRepository } from "../../domain/profile.repository.js";

export class UpsertProfileUseCase {
  constructor(private readonly repo: ProfileRepository) {}

  async execute(input: UpsertProfileInput): Promise<Profile> {
    return this.repo.upsert(input);
  }
}
