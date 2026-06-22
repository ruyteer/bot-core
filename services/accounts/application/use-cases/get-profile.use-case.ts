import { APIError } from "encore.dev/api";
import type { ProfileWithRoles } from "../../domain/profile.entity.js";
import type { ProfileRepository } from "../../domain/profile.repository.js";

export class GetProfileUseCase {
  constructor(private readonly repo: ProfileRepository) {}

  async execute(id: string): Promise<ProfileWithRoles> {
    const profile = await this.repo.findById(id);
    if (!profile) throw APIError.notFound("profile not found");
    return profile;
  }
}
