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

export type AmountCheck =
  | { ok: true; verified: true }
  // Confirmado SEM conferir o valor — registrado no log com este código.
  //   amount_is_net     só veio o valor líquido (WiinPay sempre)
  //   amount_not_gross  veio um valor, mas quem montou o evento não diz se é bruto
  //   amount_unknown    nenhum valor legível no payload
  | { ok: true; verified: false; code: "amount_is_net" | "amount_not_gross" | "amount_unknown"; reason: string }
  | { ok: false; reason: string };

function brl(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2)}`;
}

/**
 * Confere o valor pago contra o cobrado antes de confirmar a venda.
 *
 * Só RECUSA quando o payload traz o valor BRUTO e ele é menor que o cobrado
 * (além da tolerância). Conferido em produção (2026-09-24): a WiinPay só manda
 * o valor líquido, e vários webhooks legítimos chegaram sem valor legível —
 * recusar nesses casos barraria vendas reais. Neles a venda é confirmada e o
 * log registra `amount_is_net` / `amount_unknown`. A autenticidade do evento
 * não depende disto: é garantida pela autenticação/verificação ativa no
 * gateway (webhooks/conciliação).
 *
 * Bruto ACIMA do cobrado confirma: o QR dinâmico fixa o valor, então isso só
 * aparece quando o gateway soma ao total alguma taxa paga pelo comprador.
 */
export function checkPaidAmount(
  chargedCents: number,
  paid: { grossAmount?: number | null; amount?: number | null; amountIsNet?: boolean },
): AmountCheck {
  const gross = paid.grossAmount;
  if (typeof gross === "number" && Number.isFinite(gross)) {
    if (gross < chargedCents - AMOUNT_TOLERANCE_CENTS) {
      return { ok: false, reason: `valor bruto pago (${brl(gross)}) menor que o cobrado (${brl(chargedCents)})` };
    }
    return { ok: true, verified: true };
  }
  const amount = paid.amount;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    const kind = paid.amountIsNet ? "líquido (taxa já descontada)" : "sem indicação de bruto";
    return {
      ok: true, verified: false, code: paid.amountIsNet ? "amount_is_net" : "amount_not_gross",
      reason: `valor não conferido: o payload só trouxe valor ${kind} (${brl(amount)}), cobrado ${brl(chargedCents)}`,
    };
  }
  return {
    ok: true, verified: false, code: "amount_unknown",
    reason: `valor não conferido: webhook sem valor legível, cobrado ${brl(chargedCents)}`,
  };
}
