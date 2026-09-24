import { createPix, platformSplitCents } from "./gateway-clients.js";
import { resolveEffectiveSplit } from "./split-config.js";
import { GatewayDrizzleRepository } from "../infrastructure/gateway.drizzle.repository.js";
import { saveGatewayRef } from "./verify-with-gateway.js";
import type { PaymentGateway, PixPaymentResult } from "../domain/gateway.entity.js";
import type { PaymentSplitSnapshot } from "../domain/payment.entity.js";

const gwRepo = new GatewayDrizzleRepository();

export interface PixWithFallbackResult {
  gateway: PaymentGateway;
  pix:     PixPaymentResult;
  /**
   * Split efetivamente enviado a ESTE gateway nesta cobrança. Quem persiste o
   * pagamento grava isto em payments.split_snapshot — a confirmação (webhook)
   * usa o snapshot em vez de resolver o split de novo.
   */
  splitSnapshot: PaymentSplitSnapshot;
  /** Gateways que falharam antes deste dar certo (para log/diagnóstico). */
  failures: Array<{ gatewayId: string; provider: string; error: string }>;
}

export interface CreatePixOptions {
  amountCents: number;
  description: string;
  webhookUrl:  (provider: string) => string;
  // Dono do bot/gateway. Se for admin da plataforma, o PIX sai sem split (sem taxa).
  ownerUserId?: string | null;
}

/**
 * Gera o PIX percorrendo a ordem de gateways do bot: tenta o primeiro e, se a
 * criação falhar (provedor fora do ar, timeout, 403 de compliance...), cai para
 * o próximo. Antes disso, uma única falha deixava o lead sem PIX nenhum.
 *
 * Retorna null se a cadeia estiver vazia; lança se TODOS falharem (com as
 * mensagens de cada um, para o chamador logar e avisar o lead).
 */
export async function createPixWithFallback(
  chain: PaymentGateway[],
  opts: CreatePixOptions,
): Promise<PixWithFallbackResult | null> {
  if (chain.length === 0) return null;

  const failures: PixWithFallbackResult["failures"] = [];

  for (const gw of chain) {
    try {
      const { clientId, clientSecret } = gwRepo.decryptCredentials(gw);
      // Resolvido por gateway: cada um pode ter uma configuração de split
      // diferente no painel (<GW>_SPLIT_ENABLED/_FEE_CENTS por provider).
      const split = await resolveEffectiveSplit(gw.provider, opts.ownerUserId);
      const pix = await createPix(
        gw.provider, clientId, clientSecret,
        opts.amountCents, opts.description, opts.webhookUrl(gw.provider),
        { split },
      );
      // Chave de consulta no gateway (BuckPay): sem ela a conciliação não
      // consegue perguntar o status desta cobrança. Não derruba o PIX — o
      // webhook ainda pode confirmar (e grava a chave) se isto falhar.
      if (pix.gatewayRef) {
        await saveGatewayRef(gw.provider, pix.externalId, pix.gatewayRef).catch((err) =>
          console.error(`[payments] falha ao guardar gateway_ref (${gw.provider}):`, err));
      }
      if (failures.length > 0) {
        console.warn(`[payments] PIX gerado no fallback ${gw.provider} (${gw.id}) após ${failures.length} falha(s)`);
      }
      const splitSnapshot: PaymentSplitSnapshot = split
        ? { receiver: split.receiver, cents: split.cents, feeCents: platformSplitCents(gw.provider, opts.amountCents, split.cents) }
        : { receiver: null, cents: 0, feeCents: 0 };
      return { gateway: gw, pix, splitSnapshot, failures };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[payments] createPix falhou no gateway ${gw.provider} (${gw.id}):`, error);
      failures.push({ gatewayId: gw.id, provider: gw.provider, error });
    }
  }

  throw new Error(
    `todos os gateways falharam: ${failures.map((f) => `${f.provider}: ${f.error}`).join("; ")}`,
  );
}
