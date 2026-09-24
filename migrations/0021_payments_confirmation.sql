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
-- Só colunas novas e nullable: nenhum dado existente é alterado.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "split_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "delivery_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;
