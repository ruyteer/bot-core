import { eq } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { referrals, referralCommissions } from "../../shared/schema/index.js";
import { isPlatformAdmin } from "../../shared/roles.js";
import { platformFeeCentsFor, commissionPercentFor } from "./referral-config.js";

/**
 * Credita a comissão de indicação quando uma venda do seller indicado é paga.
 * Chamada pelo webhook de pagamento (payments) — NUNCA pode derrubar a
 * confirmação da venda, por isso engole os próprios erros.
 *
 * `baseFeeCentsOverride`: taxa efetiva (centavos) já resolvida pelo chamador
 * via payments/application/split-config.ts#resolveEffectiveSplit — é a taxa
 * REAL cobrada nesse gateway/venda específica (pode divergir do fallback
 * genérico USER_SPLIT_FEE_CENTS/PLATFORM_SPLIT_CENTS de platformFeeCentsFor,
 * ex.: <GW>_SPLIT_FEE_CENTS custom pra esse provider). Quando omitido, cai no
 * comportamento antigo (platformFeeCentsFor) — mantém os testes que chamam
 * esta função isoladamente, fora do fluxo de webhook, funcionando.
 *
 * Idempotente: UNIQUE(payment_id) + onConflictDoNothing — webhook reprocessado
 * não credita duas vezes.
 */
export async function accrueReferralCommission(
  paymentId: string,
  sellerUserId: string,
  baseFeeCentsOverride?: number,
): Promise<void> {
  try {
    const [ref] = await db.select().from(referrals)
      .where(eq(referrals.referredUserId, sellerUserId)).limit(1);
    if (!ref) return;

    // Admin não paga a taxa da plataforma (PIX sem split) → não há receita
    // para comissionar.
    if (await isPlatformAdmin(sellerUserId)) return;

    const baseFee = baseFeeCentsOverride ?? await platformFeeCentsFor(sellerUserId);
    const percent = await commissionPercentFor(ref.referrerUserId);
    const amount  = Math.floor((baseFee * percent) / 100);
    if (amount <= 0) return;

    await db.insert(referralCommissions).values({
      referrerUserId: ref.referrerUserId,
      referredUserId: sellerUserId,
      paymentId,
      baseFeeCents:   baseFee,
      percent,
      amountCents:    amount,
    }).onConflictDoNothing();
  } catch (err) {
    console.error("[referrals] falha ao acumular comissão:", err);
  }
}
