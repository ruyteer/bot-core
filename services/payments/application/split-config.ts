import type { Provider } from "../domain/gateway.entity.js";
import { isPlatformAdmin } from "../../shared/roles.js";
import { configValue, userSplitFeeOverrideCents } from "../../referrals/application/referral-config.js";
import { PLATFORM_SPLIT_CENTS, splitReceiverFor } from "./gateway-clients.js";

export interface EffectiveSplit {
  receiver: string;
  cents:    number;
}

function gwConfigKey(provider: Provider, suffix: string): string {
  return `${provider.toUpperCase()}_${suffix}`;
}

// BuckPay identifica o recebedor do split por E-MAIL cadastrado na Buck
// (BUCKPAY_SPLIT_EMAIL); os demais providers usam user_id/client_id
// (<GW>_SPLIT_USER_ID) — mesma convenção da UI (AdminGateways.tsx) e do
// secret equivalente em gateway-clients.ts.
function receiverConfigKey(provider: Provider): string {
  return gwConfigKey(provider, provider === "buckpay" ? "SPLIT_EMAIL" : "SPLIT_USER_ID");
}

/**
 * Fonte única de verdade para "quanto e pra quem a plataforma retém de split
 * nesse PIX". Antes desse resolver, o painel de admin escrevia
 * <GW>_SPLIT_ENABLED / <GW>_SPLIT_USER_ID / <GW>_SPLIT_FEE_CENTS e
 * USER_SPLIT_FEE_CENTS_<userId> em platform_config, mas o core nunca lia
 * nada disso — o PIX real seguia só os secrets do Encore + PLATFORM_SPLIT_CENTS
 * fixo, então desligar o split ou zerar a taxa de um usuário no painel não
 * tinha efeito nenhum. Este é agora o ÚNICO lugar que decide split — os 3
 * call sites (create-pix-with-fallback.ts, payments.api.ts#testGateway,
 * webhooks.ts#creditPlatformRevenue) só usam o resultado, sem lógica própria.
 *
 * Precedência (mais específico → mais genérico):
 *   1. Admin da plataforma → sem split.
 *   2. USER_SPLIT_FEE_CENTS_<ownerUserId> (painel do usuário) → essa taxa,
 *      valendo mesmo que o gateway esteja com split desligado; 0 = taxa
 *      zerada explicitamente para esse usuário → sem split.
 *   3. <GW>_SPLIT_ENABLED=false (painel do gateway) → sem split.
 *   4. <GW>_SPLIT_FEE_CENTS / <GW>_SPLIT_USER_ID (painel do gateway) →
 *      overrides de taxa/recebedor pra esse gateway.
 *   5. Fallback: secret do Encore (splitReceiverFor) + PLATFORM_SPLIT_CENTS
 *      — comportamento antigo, preservado quando nada foi configurado no painel.
 */
export async function resolveEffectiveSplit(
  provider: Provider,
  ownerUserId: string | null | undefined,
): Promise<EffectiveSplit | null> {
  if (await isPlatformAdmin(ownerUserId)) return null;

  if (ownerUserId) {
    const userFeeCents = await userSplitFeeOverrideCents(ownerUserId);
    if (userFeeCents !== null) {
      if (userFeeCents <= 0) return null; // taxa zerada explicitamente pro usuário
      const receiver = (await configValue(receiverConfigKey(provider))) ?? splitReceiverFor(provider);
      if (!receiver) return null; // sem recebedor configurado pra esse gateway
      return { receiver, cents: userFeeCents };
    }
  }

  const enabled = await configValue(gwConfigKey(provider, "SPLIT_ENABLED"));
  if (enabled === "false") return null; // desligado explicitamente pra esse gateway no painel

  const configuredFeeRaw  = await configValue(gwConfigKey(provider, "SPLIT_FEE_CENTS"));
  const configuredReceiver = await configValue(receiverConfigKey(provider));
  if (configuredFeeRaw !== null || configuredReceiver !== null) {
    const cents = configuredFeeRaw !== null ? Number(configuredFeeRaw) : PLATFORM_SPLIT_CENTS;
    if (!Number.isFinite(cents) || cents <= 0) return null;
    const receiver = configuredReceiver ?? splitReceiverFor(provider);
    if (!receiver) return null;
    return { receiver, cents };
  }

  const receiver = splitReceiverFor(provider);
  if (!receiver) return null; // sem secret configurado nesse gateway — sem split
  return { receiver, cents: PLATFORM_SPLIT_CENTS };
}
