import { api, APIError, Header } from "encore.dev/api";
import { nextAuthIssuer } from "../config/secrets.js";
import { readOptionalSecret, verifyAuthToken } from "./auth.handler.js";
import { parseProvisionClaims } from "./domain/provision-claims.js";
import { ProfileDrizzleRepository } from "./infrastructure/profile.drizzle.repository.js";
import { ProvisionProfileUseCase } from "./application/use-cases/provision-profile.use-case.js";

// Audience PRÓPRIA deste endpoint — nunca a mesma do resto da API
// (NEXT_AUTH_AUDIENCE, "orionbot-core"). Garante que um token comum de API
// não sirva aqui, e que um token de provisionamento não sirva no authHandler
// normal (ver testes cruzados em provision.api.test.ts).
export const PROVISION_AUDIENCE = "orionbot-core:provision";

interface ProvisionParams {
  authorization: Header<"Authorization">;
}

interface ProvisionResponse {
  status: "created" | "exists" | "email_taken";
  /** Só presente quando status = "email_taken": id do perfil que já usa este e-mail. */
  userId?: string;
}

const repo             = new ProfileDrizzleRepository();
const provisionProfile = new ProvisionProfileUseCase(repo);

// POST /accounts/provision — provisiona a conta no core assim que o cadastro
// acontece na UI nova.
//
// `auth: false` de propósito: neste momento o usuário AINDA NÃO TEM sessão no
// core (é o próprio cadastro) — não dá pra usar o authHandler padrão. A
// verificação do JWT acontece manualmente aqui, com o MESMO emissor/JWKS do
// authHandler (NEXT_AUTH_ISSUER), mas com uma audience própria
// (PROVISION_AUDIENCE) — isso é o que impede um token de API comum de servir
// aqui, e vice-versa.
//
// Existe porque hoje o authHandler cria perfil por efeito colateral
// (upsertProfile, em TODA requisição autenticada) sem nenhuma trava por
// e-mail — `profiles.email` não tem unique constraint no schema, então dois
// cadastros simultâneos com o mesmo e-mail criavam duas linhas em profiles.
// Este endpoint centraliza o provisionamento com lock por e-mail normalizado,
// dentro de uma única transação (ver ProfileDrizzleRepository.provision).
export const provision = api(
  { method: "POST", path: "/accounts/provision", expose: true, auth: false },
  async ({ authorization }: ProvisionParams): Promise<ProvisionResponse> => {
    const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
    if (!token) throw APIError.unauthenticated("missing token");

    const payload = await verifyAuthToken(token, {
      supabaseUrl:    "", // este endpoint só aceita o emissor novo, nunca o Supabase
      nextAuthIssuer: readOptionalSecret(nextAuthIssuer) || undefined,
      audience:       PROVISION_AUDIENCE,
    });

    // Token de provisionamento precisa ter vida curta — exp é obrigatório
    // (jose só valida expiração quando o claim está presente; sem isto um
    // token sem `exp` nunca expiraria).
    if (typeof payload.exp !== "number") {
      throw APIError.unauthenticated("token sem expiração (claim exp ausente)");
    }

    const input = parseProvisionClaims(payload);
    return provisionProfile.execute(input);
  },
);
