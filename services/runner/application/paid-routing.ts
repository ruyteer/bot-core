import type { Payment } from "../../payments/domain/payment.entity.js";

/**
 * Para onde vai um pagamento confirmado. O critério é o CONTEXTO DE FUNIL
 * FLOW (nó + progresso), não a presença de `simplifiedCtx`: desde que o flow
 * passou a ter order bump, uma compra flow com bump também carrega
 * `simplifiedCtx.items` (os extras a entregar) — decidir por esse campo
 * mandava a compra pro runner do simplificado, que entrega só os extras e
 * nunca o produto principal nem retoma o funil.
 */
export type PaidRoute = "flow" | "simplified";

export function routePaidPayment(payment: Pick<Payment, "nodeId" | "progressId" | "simplifiedCtx">): PaidRoute {
  if (payment.nodeId && payment.progressId) return "flow";
  if (payment.simplifiedCtx) return "simplified";
  // Sem contexto de funil (oferta avulsa de disparo/remarketing): o flow já
  // trata esse caso em handlePaidOffer (entrega pelo offerId).
  return "flow";
}
