-- Conciliação de pagamentos com o gateway (auditoria do backend, 24/09): não
-- existia nenhum job conferindo pagamentos pendentes contra o gateway — um
-- webhook perdido (gateway fora, deploy no meio, cadastro de webhook ausente
-- na SyncPay) deixava a venda pendente pra sempre, com o cliente tendo pago.
--
-- payment_reconciliation: uma linha por cobrança, chaveada como o pagamento é
-- casado — (provider, external_id).
-- - gateway_ref: chave de CONSULTA no gateway quando difere do external_id
--   gravado em payments (BuckPay só consulta pelo external_id que nós enviamos
--   na criação; payments.external_id guarda o id interno dela).
-- - last_checked_at/check_count: backoff do job — sem isso cada tick
--   consultaria de novo todo PIX pendente das últimas 24h no gateway.
--
-- Tabela nova: não altera nem apaga dado existente.
CREATE TABLE IF NOT EXISTS "payment_reconciliation" (
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"gateway_ref" text,
	"last_checked_at" timestamp with time zone,
	"check_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reconciliation_provider_external_id_pk" PRIMARY KEY("provider","external_id")
);
