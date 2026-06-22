import { authHandler } from "encore.dev/auth";
import { APIError, Gateway, Header } from "encore.dev/api";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { supabaseUrl } from "../config/secrets.js";
import { ProfileDrizzleRepository } from "./infrastructure/profile.drizzle.repository.js";
import { UpsertProfileUseCase } from "./application/use-cases/upsert-profile.use-case.js";

interface AuthParams {
  authorization: Header<"Authorization">;
}

export interface AuthData {
  userID: string;  // Encore exige "userID" (capital D) — = Supabase auth UUID = profiles.id
}

interface SupabaseJwtPayload {
  sub:            string;
  email?:         string;
  user_metadata?: { name?: string; full_name?: string };
  exp:            number;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${supabaseUrl()}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

const repo          = new ProfileDrizzleRepository();
const upsertProfile = new UpsertProfileUseCase(repo);

export const auth = authHandler<AuthParams, AuthData>(async (params) => {
  const token = params.authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!token) throw APIError.unauthenticated("missing token");

  let payload: SupabaseJwtPayload;
  try {
    const { payload: p } = await jwtVerify(token, getJwks());
    payload = p as unknown as SupabaseJwtPayload;
  } catch (e: any) {
    throw APIError.unauthenticated(`invalid or expired token: ${e?.message}`);
  }

  // Auto-upsert profile on every request so new users are provisioned transparently
  await upsertProfile.execute({
    id:    payload.sub,
    email: payload.email ?? "",
    name:  payload.user_metadata?.full_name ?? payload.user_metadata?.name ?? "",
  });

  return { userID: payload.sub };
});

export const gateway = new Gateway({ authHandler: auth });
