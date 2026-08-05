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
 * Idempotente: UNIQUE(payment_id) + onConflictDoNothing — webhook reprocessado
 * não credita duas vezes.
 */
export async function accrueReferralCommission(paymentId: string, sellerUserId: string): Promise<void> {
  try {
    const [ref] = await db.select().from(referrals)
      .where(eq(referrals.referredUserId, sellerUserId)).limit(1);
    if (!ref) return;

    // Admin não paga a taxa da plataforma (PIX sem split) → não há receita
    // para comissionar.
    if (await isPlatformAdmin(sellerUserId)) return;

    const baseFee = await platformFeeCentsFor(sellerUserId);
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
