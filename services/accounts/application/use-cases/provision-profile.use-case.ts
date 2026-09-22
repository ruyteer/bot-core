import type { ProvisionProfileInput, ProvisionProfileResult } from "../../domain/profile.entity.js";
import type { ProfileRepository } from "../../domain/profile.repository.js";

export class ProvisionProfileUseCase {
  constructor(private readonly repo: ProfileRepository) {}

  async execute(input: ProvisionProfileInput): Promise<ProvisionProfileResult> {
    return this.repo.provision(input);
  }
}
