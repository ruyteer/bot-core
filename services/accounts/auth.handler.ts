import { authHandler } from "encore.dev/auth";
import { APIError, Gateway, Header } from "encore.dev/api";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { nextAuthIssuer } from "../config/secrets.js";
import { ProfileDrizzleRepository } from "./infrastructure/profile.drizzle.repository.js";
import { UpsertProfileUseCase } from "./application/use-cases/upsert-profile.use-case.js";

interface AuthParams {
  authorization: Header<"Authorization">;
}

export interface AuthData {
  userID: string;  // Encore exige "userID" (capital D) — = profiles.id (UUID)
}

export interface AuthJwtPayload {
  sub:            string;
  email?:         string;
  user_metadata?: { name?: string; full_name?: string };
  exp:            number;
}

// Depois da virada: só o JWT ES256 do app novo. O emissor do Supabase (UI
// antiga) não é mais aceito — mergear este PR antes disso derruba o login
// legado. O `iss` do token tem que bater com NEXT_AUTH_ISSUER; qualquer
// outro (incluindo o URL do projeto Supabase) é rejeitado.
export interface AuthIssuersConfig {
  /** URL do app Next. Ausente/vazio = recusa todos os tokens. */
  nextAuthIssuer?: string;
  /** Só para teste: injeta o fetch usado pra buscar o JWKS, sem tocar rede. */
  fetchImpl?: typeof fetch;
}

const NEXT_AUTH_AUDIENCE = "orionbot-core";

// Um createRemoteJWKSet por URL de JWKS, cacheado — o jose já cacheia as
// chaves dentro de cada JWKS set; recriar a cada request perderia esse cache
// e bateria no emissor a cada requisição autenticada.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(jwksUrl: string, fetchImpl?: typeof fetch): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByUrl.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl), fetchImpl ? { [customFetch]: fetchImpl } : undefined);
    jwksByUrl.set(jwksUrl, jwks);
  }
  return jwks;
}

/**
 * Verifica o JWT com o JWKS do app novo. `iss` desconhecido é sempre rejeitado
 * — não há mais fallback para o Supabase.
 *
 * Exige `issuer`, `audience` e `algorithms: ["ES256"]` no `jwtVerify` — sem
 * restringir o algoritmo, o `alg` do header do token vira superfície de ataque.
 */
export async function verifyAuthToken(token: string, config: AuthIssuersConfig): Promise<AuthJwtPayload> {
  let iss: string | undefined;
  try {
    ({ iss } = decodeJwt(token));
  } catch {
    throw APIError.unauthenticated("invalid token");
  }

  if (typeof iss !== "string" || !config.nextAuthIssuer || iss !== config.nextAuthIssuer) {
    throw APIError.unauthenticated("unknown token issuer");
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(
      token,
      jwksFor(`${config.nextAuthIssuer}/.well-known/jwks.json`, config.fetchImpl),
      { issuer: config.nextAuthIssuer, audience: NEXT_AUTH_AUDIENCE, algorithms: ["ES256"] },
    ));
  } catch (e: any) {
    throw APIError.unauthenticated(`invalid or expired token: ${e?.message}`);
  }

  return payload as unknown as AuthJwtPayload;
}

// Se NEXT_AUTH_ISSUER não estiver setado, `nextAuthIssuer()` lança em
// ambiente deployado. Engolimos o erro e recusamos o token — o boot do
// processo não pode cair por um segredo ausente no meio de um restart.
function readOptionalSecret(fn: () => string): string {
  try {
    return fn() || "";
  } catch {
    return "";
  }
}

const repo          = new ProfileDrizzleRepository();
const upsertProfile = new UpsertProfileUseCase(repo);

export const auth = authHandler<AuthParams, AuthData>(async (params) => {
  const token = params.authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!token) throw APIError.unauthenticated("missing token");

  const payload = await verifyAuthToken(token, {
    nextAuthIssuer: readOptionalSecret(nextAuthIssuer) || undefined,
  });

  // Auto-upsert profile on every request so new users are provisioned transparently
  await upsertProfile.execute({
    id:    payload.sub,
    email: payload.email ?? "",
    name:  payload.user_metadata?.full_name ?? payload.user_metadata?.name ?? "",
  });

  return { userID: payload.sub };
});

export const gateway = new Gateway({ authHandler: auth });
