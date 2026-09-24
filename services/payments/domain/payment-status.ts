// Máquina de estados de `payments.status` e conferência do valor pago.
//
// Antes, o webhook aplicava qualquer status que chegasse, em qualquer ordem:
// um "expirado"/"cancelado" que chegasse DEPOIS do "pago" rebaixava a venda
// (e vice-versa, um "pago" reaplicado disparava a entrega de novo). Aqui fica a
// única definição de quais transições valem; o repositório aplica cada uma com
// um UPDATE condicionado ao status de origem (ver transitionStatus), então a
// transição é atômica mesmo com webhooks concorrentes.

export type PaymentStatus = "pending" | "paid" | "cancelled" | "expired";

/**
 * Para cada status de destino, de quais status ele pode vir.
 *
 * - pending → paid | cancelled | expired: o ciclo normal da cobrança.
 * - expired → paid: `expired` também é marcado LOCALMENTE pelo runner
 *   (execute-flow-step.use-case.ts, re-clique na oferta depois do
 *   unpaid_timeout) enquanto o PIX continua pagável no gateway. Se o lead paga
 *   esse código depois, o dinheiro entrou de verdade — recusar a confirmação
 *   deixaria o comprador pago e sem produto.
 * - expired → cancelled: só atualiza o motivo do encerramento; nada é entregue.
 * - paid → (nada): reembolso/estorno/expiração que chegue depois do pago é
 *   registrado no log do webhook e ignorado. Revogar acesso/conteúdo num
 *   estorno é decisão de produto que ainda não existe.
 * - cancelled → (nada): um "pago" depois de cancelado/estornado é suspeito e
 *   fica registrado para conferência manual, sem entregar.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending:   [],
  paid:      ["pending", "expired"],
  cancelled: ["pending", "expired"],
  expired:   ["pending"],
};

export function allowedSourcesFor(target: PaymentStatus): readonly PaymentStatus[] {
  return PAYMENT_TRANSITIONS[target];
}

export function canTransition(from: string, to: PaymentStatus): boolean {
  return (PAYMENT_TRANSITIONS[to] as readonly string[]).includes(from);
}

/**
 * Tolerância (centavos) entre o valor cobrado e o valor que o gateway diz ter
 * recebido. Os gateways trafegam REAIS em ponto flutuante (syncpay, nexuspag,
 * wiinpay) e a volta pra centavos pode perder 1 centavo no arredondamento/
 * truncamento — mais do que isso é divergência de verdade.
 */
export const AMOUNT_TOLERANCE_CENTS = 1;

export type AmountCheck = { ok: true } | { ok: false; reason: string };

function brl(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2)}`;
}

/**
 * Confere o valor pago contra o cobrado antes de confirmar a venda.
 *
 * - Sem valor no evento → não confirma: não há como saber se bate.
 * - Pago abaixo do cobrado (além da tolerância) → não confirma.
 * - Pago acima do cobrado → confirma. O QR dinâmico fixa o valor, então isso só
 *   aparece quando o gateway soma alguma taxa paga pelo comprador ao total —
 *   o vendedor recebeu o que cobrou, recusar só deixaria o comprador sem produto.
 */
export function checkPaidAmount(chargedCents: number, paidCents: number | null | undefined): AmountCheck {
  if (paidCents === null || paidCents === undefined || !Number.isFinite(paidCents)) {
    return { ok: false, reason: `webhook de pagamento sem valor: não dá pra conferir contra o cobrado (${brl(chargedCents)})` };
  }
  if (paidCents < chargedCents - AMOUNT_TOLERANCE_CENTS) {
    return { ok: false, reason: `valor pago (${brl(paidCents)}) menor que o cobrado (${brl(chargedCents)})` };
  }
  return { ok: true };
}
