import { APIError } from "encore.dev/api";
import type { AuthJwtPayload } from "../auth.handler.js";
import type { ProvisionProfileInput } from "./profile.entity.js";

// Mesma convenção de UUID usada no resto do projeto (ver, por ex.,
// services/funnels/infrastructure/funnel.drizzle.repository.ts).
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Mesma regex de e-mail usada em services/runner/application/execute-flow-step.use-case.ts.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 120;

/**
 * Valida e normaliza as claims do JWT de provisionamento (sub / email /
 * user_metadata.name). Lança `APIError.invalidArgument` (mesma convenção do
 * resto do serviço — ver services/funnels/domain/offer-validation.ts) quando
 * alguma claim vier fora do formato esperado.
 *
 * Erros de verificação do TOKEN em si (assinatura, issuer, audience,
 * expiração) já são tratados antes disto, em verifyAuthToken
 * (auth.handler.ts) — aqui só validamos o CONTEÚDO das claims.
 */
export function parseProvisionClaims(payload: AuthJwtPayload): ProvisionProfileInput {
  const sub = payload.sub;
  if (typeof sub !== "string" || !UUID_REGEX.test(sub)) {
    throw APIError.invalidArgument("sub precisa ser um UUID válido");
  }

  const email = (payload.email ?? "").trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    throw APIError.invalidArgument("email inválido");
  }

  // Mesma prioridade que o authHandler usa (auth.handler.ts): full_name antes
  // de name, quando ambos vierem no user_metadata.
  const name = (payload.user_metadata?.full_name ?? payload.user_metadata?.name ?? "").trim();
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    throw APIError.invalidArgument(`name precisa ter entre ${NAME_MIN_LENGTH} e ${NAME_MAX_LENGTH} caracteres`);
  }

  return { id: sub, email, name };
}
