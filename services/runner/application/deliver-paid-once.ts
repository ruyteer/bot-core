import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import type { Payment } from "../../payments/domain/payment.entity.js";

const payRepo = new PaymentDrizzleRepository();

export type PaidDeliveryResult = "delivered" | "skipped" | "failed";

/**
 * Entrega de um pagamento pago EXATAMENTE uma vez, mesmo com o tópico
 * paymentPaid sendo at-least-once (e com a confirmação podendo republicar o
 * evento na recuperação de uma entrega que não foi reivindicada).
 *
 * Antes o subscriber fazia findById → entrega: cada reentrega da mesma
 * mensagem entregava de novo (conteúdo, convite/acesso ao grupo VIP, retomada
 * do funil pelo __paid). Agora a entrega é reivindicada com um UPDATE atômico
 * (claimDelivery: status = 'paid' AND delivered_at IS NULL AND
 * delivery_claimed_at IS NULL ... RETURNING); só quem recebe a linha entrega.
 *
 * Falha no meio da entrega fica reivindicada e sem delivered_at, e é só
 * logada — mesma semântica de antes (o handler nunca relançava, então o Encore
 * não reentregava). Uma reivindicação velha sem delivered_at (processo morreu
 * no meio) pode ser retomada depois do prazo de claimDelivery.
 */
export async function deliverPaidOnce(
  paymentId: string,
  deliver: (payment: Payment) => Promise<void>,
): Promise<PaidDeliveryResult> {
  const payment = await payRepo.claimDelivery(paymentId);
  if (!payment) return "skipped"; // já entregue/em entrega, ou não está pago
  try {
    await deliver(payment);
  } catch (err) {
    console.error(`[runner] error handling paid payment ${paymentId}:`, err);
    return "failed";
  }
  await payRepo.markDelivered(paymentId);
  return "delivered";
}
