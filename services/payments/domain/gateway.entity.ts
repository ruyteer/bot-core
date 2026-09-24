export type Provider = "syncpay" | "buckpay" | "nexuspag" | "wiinpay";

export interface PaymentGateway {
  id:           string;
  userId:       string;
  provider:     Provider;
  label:        string;
  clientId:     string;     // encrypted
  clientSecret: string;     // encrypted (or sentinel for no-secret providers)
  isActive:     boolean;
  createdAt:    Date;
  updatedAt:    Date;
}

// Safe projection — never includes raw credentials
export interface GatewaySafe {
  id:       string;
  provider: Provider;
  label:    string;
  isActive: boolean;
}

export interface CreateGatewayInput {
  userId:       string;
  provider:     Provider;
  label:        string;
  clientId:     string;
  // Só o SyncPay usa client secret — os demais provedores são forçados hoje a
  // mandar string vazia (ou um sentinel) pra satisfazer o tipo. Opcional aqui;
  // a validação de que o SyncPay precisa dele fica no endpoint.
  clientSecret?: string;
}

export interface UpdateGatewayInput {
  label?:        string;
  clientId?:     string;
  clientSecret?: string;
}

export interface PixPaymentResult {
  pixCode:     string;
  qrImage:     string;
  externalId:  string;
  // Chave de consulta da cobrança no gateway quando ela é DIFERENTE do
  // externalId (hoje só BuckPay: consulta pelo external_id que nós enviamos).
  // Persistida em payment_reconciliation para a conciliação/verificação.
  gatewayRef?: string;
  amount:      number;
  provider:    Provider;
  institution: string;
}
