-- Idempotência de webhooks passa a considerar o status: uma venda gera vários
-- webhooks com o MESMO external_id ao longo do tempo (ex.: SyncPay manda
-- pending/waiting_for_approval na criação e só depois paid_out na
-- confirmação). Com a chave antiga (external_id, provider), o primeiro
-- webhook travava a transação como "processada" pra sempre e o webhook de
-- confirmação de pagamento que chegava depois era descartado silenciosamente.
ALTER TABLE "processed_webhooks" DROP CONSTRAINT "processed_webhooks_external_id_provider_pk";--> statement-breakpoint
ALTER TABLE "processed_webhooks" ADD CONSTRAINT "processed_webhooks_external_id_provider_status_pk" PRIMARY KEY("external_id","provider","status");
