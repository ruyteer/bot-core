import { authHandler } from "encore.dev/auth";
import { APIError, Gateway, Header } from "encore.dev/api";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { supabaseUrl, nextAuthIssuer } from "../config/secrets.js";
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

// Convivência temporária entre dois emissores de JWT enquanto migramos a
// autenticação pra fora do Supabase:
//   - Supabase (legado): continua servindo o bot-ui antigo, em produção.
//   - app novo (Next): ES256 próprio, `iss` = URL do app, JWKS publicado em
//     `<iss>/.well-known/jwks.json`.
// O emissor é escolhido pelo claim `iss` do token — nunca por um default.
export interface AuthIssuersConfig {
  /** URL do projeto Supabase (emissor legado). */
  supabaseUrl: string;
  /** URL do app Next novo. Ausente/vazio = segredo ainda não configurado. */
  nextAuthIssuer?: string;
  /** Só para teste: injeta o fetch usado pra buscar o JWKS, sem tocar rede. */
  fetchImpl?: typeof fetch;
  /**
   * Audience esperada no token do emissor novo. Default: NEXT_AUTH_AUDIENCE
   * (comportamento atual do authHandler, inalterado). Outros endpoints que
   * aceitam o MESMO emissor/JWKS mas exigem uma audience própria (ex. POST
   * /accounts/provision, ver provision.api.ts) passam a sua aqui — assim um
   * token comum de API não serve nesses endpoints, e vice-versa.
   */
  audience?: string;
}

export const NEXT_AUTH_AUDIENCE = "orionbot-core";

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
 * Escolhe o emissor pelo claim `iss` do token (decodificado sem validar) e
 * verifica com o JWKS correspondente. `iss` desconhecido é sempre rejeitado.
 *
 * Caminho Supabase: sem nenhuma mudança de comportamento (mesmo JWKS, mesma
 * validação de sempre — sem restringir `issuer`/`audience`/`algorithms`).
 * Caminho do app novo: exige `issuer`, `audience` e `algorithms: ["ES256"]`
 * no `jwtVerify` — sem restringir o algoritmo, o `alg` do header do token vira
 * superfície de ataque.
 */
export async function verifyAuthToken(token: string, config: AuthIssuersConfig): Promise<AuthJwtPayload> {
  let iss: string | undefined;
  try {
    ({ iss } = decodeJwt(token));
  } catch {
    throw APIError.unauthenticated("invalid token");
  }

  let payload: JWTPayload;
  if (typeof iss === "string" && !!config.supabaseUrl && iss === config.supabaseUrl) {
    try {
      ({ payload } = await jwtVerify(
        token,
        jwksFor(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`, config.fetchImpl),
      ));
    } catch (e: any) {
      throw APIError.unauthenticated(`invalid or expired token: ${e?.message}`);
    }
  } else if (typeof iss === "string" && !!config.nextAuthIssuer && iss === config.nextAuthIssuer) {
    try {
      ({ payload } = await jwtVerify(
        token,
        jwksFor(`${config.nextAuthIssuer}/.well-known/jwks.json`, config.fetchImpl),
        { issuer: config.nextAuthIssuer, audience: config.audience ?? NEXT_AUTH_AUDIENCE, algorithms: ["ES256"] },
      ));
    } catch (e: any) {
      throw APIError.unauthenticated(`invalid or expired token: ${e?.message}`);
    }
  } else {
    throw APIError.unauthenticated("unknown token issuer");
  }

  return payload as unknown as AuthJwtPayload;
}

// Secret opcional: se NEXT_AUTH_ISSUER não estiver setado (segredo novo, ainda
// sem valor em produção até o app novo entrar no ar), `nextAuthIssuer()`
// lança em ambiente deployado — o core precisa continuar de pé só com
// Supabase, então o erro é engolido e tratado como "não configurado".
export function readOptionalSecret(fn: () => string): string {
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
    supabaseUrl:    supabaseUrl(),
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
