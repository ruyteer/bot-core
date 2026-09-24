// Item entregável de uma compra do funil simplificado (plano, bump, upsell ou downsell).
export interface SimplifiedDeliveryItem {
  name:           string;
  delivery_type:  "content" | "vip_group" | "text";
  delivery_url?:  string | null;
  delivery_text?: string | null;
  vip_group_id?:  string | null;
  access_days?:   number;
}

// Contexto persistido no payment p/ entregar e agendar após o pagamento (simplificado).
export interface SimplifiedPaymentCtx {
  kind:     "plan" | "upsell" | "downsell";
  funnelId: string;
  planId?:  string;   // presente p/ kind "plan" (usado p/ agendar upsells)
  items:    SimplifiedDeliveryItem[];
}

// Split aplicado NO GATEWAY quando a cobrança foi criada (createPixWithFallback).
// A confirmação usa este snapshot em vez de resolver o split de novo — a config
// do painel pode ter mudado entre o PIX e o pagamento, e a receita/comissão tem
// que refletir o que de fato foi retido naquela transação.
// `cents: 0` = cobrança criada SEM split (admin, split desligado, taxa zerada).
export interface PaymentSplitSnapshot {
  receiver: string | null;
  /** Taxa-alvo configurada (centavos) — base da comissão de indicação. */
  cents:    number;
  /** Quanto o gateway efetivamente retém (platformSplitCents) — receita da plataforma. */
  feeCents: number;
}

export interface Payment {
  id:               string;
  userId:           string;
  botId:            string;
  leadId:           string | null;
  gatewayId:        string;
  offerId:          string | null;
  offerName:        string | null;
  offerExternalRef: string | null;
  amount:           number;
  finalAmount:      number | null;
  status:           string;
  saleType:         string | null;
  externalId:       string | null;
  pixCode:          string | null;
  endToEnd:         string | null;
  paidAt:           Date | null;
  description:      string | null;
  funnelId:         string | null;
  progressId:       string | null;
  nodeId:           string | null;
  paidHandle:       string | null;
  simplifiedCtx:    SimplifiedPaymentCtx | null;
  // null = cobrança anterior à migration 0021 (sem snapshot): a confirmação cai
  // no cálculo antigo (resolveEffectiveSplit na hora).
  splitSnapshot:     PaymentSplitSnapshot | null;
  // Guarda de entrega exatamente-uma-vez do evento paymentPaid (at-least-once).
  deliveryClaimedAt: Date | null;
  deliveredAt:       Date | null;
  createdAt:        Date;
  updatedAt:        Date;
}

export interface PaymentWithMeta extends Payment {
  botName:         string | null;
  botUsername:     string | null;
  leadName:        string | null;
  leadUsername:    string | null;
  leadChatId:      string | null;
  provider:        string | null;
  gatewayLabel:    string | null;
}
