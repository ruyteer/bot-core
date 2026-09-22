export interface Profile {
  id:        string;  // = Supabase auth UUID
  email:     string;
  name:      string;
  isBlocked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileWithRoles extends Profile {
  roles: string[];
  isAdmin: boolean;
}

export interface UpsertProfileInput {
  id:    string;
  email: string;
  name:  string;
}

export interface ProvisionProfileInput {
  id:    string;  // sub do JWT — UUID gerado pela UI
  email: string;  // já normalizado (trim + lowercase) por quem chama
  name:  string;
}

// Resultado do provisionamento (ver ProfileDrizzleRepository.provision):
// - created:     perfil novo inserido.
// - exists:      já existia perfil com este id — idempotente, nada é alterado.
// - email_taken: o e-mail já pertence a OUTRO id — nada é inserido.
export type ProvisionProfileResult =
  | { status: "created" }
  | { status: "exists" }
  | { status: "email_taken"; userId: string };
