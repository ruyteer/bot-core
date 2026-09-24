-- Confirmação de pagamento (auditoria do backend, 24/09):
--
-- split_snapshot: o split que o gateway reteve é decidido na CRIAÇÃO do PIX
-- (createPixWithFallback → resolveEffectiveSplit), mas a confirmação resolvia
-- tudo de novo na hora do webhook. Se o painel mudasse entre a cobrança e o
-- pagamento (split ligado/desligado, taxa do usuário), a receita da plataforma
-- e a comissão de indicação divergiam do que foi de fato cobrado. Agora a
-- criação grava { receiver, cents, feeCents } e a confirmação só lê. NULL =
-- cobrança anterior a esta migration (a confirmação cai no cálculo antigo).
--
-- delivery_claimed_at / delivered_at: o tópico paymentPaid é at-least-once; a
-- mesma mensagem podia entregar produto/grupo VIP duas vezes. O subscriber do
-- runner agora reivindica a entrega com UPDATE ... WHERE delivery_claimed_at
-- IS NULL RETURNING antes de entregar.
--
-- ALTERA DADO EXISTENTE (backfill): toda venda JÁ PAGA antes desta migration
-- já foi entregue pelo código antigo, mas nasceria com delivered_at NULL — e
-- aí um webhook de pago reentregue (ou a conciliação) republicaria
-- paymentPaid e claimDelivery aceitaria, reentregando produto/VIP de meses
-- atrás. O backfill marca essas vendas como entregues em paid_at (ou
-- updated_at, se paid_at faltar). Roda UMA vez, no mesmo bloco que cria a
-- coluna delivered_at: se rodasse sempre (ensure-schema roda a cada boot),
-- marcaria como entregue uma venda paga depois do deploy cuja entrega ainda
-- estivesse a caminho num restart — e ela nunca seria entregue.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "split_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "delivery_claimed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'payments' AND column_name = 'delivered_at'
  ) THEN
    ALTER TABLE "payments" ADD COLUMN "delivered_at" timestamp with time zone;
    UPDATE "payments"
       SET "delivered_at"        = COALESCE("paid_at", "updated_at"),
           "delivery_claimed_at" = COALESCE("delivery_claimed_at", "paid_at", "updated_at")
     WHERE "status" = 'paid';
  END IF;
END $$;
