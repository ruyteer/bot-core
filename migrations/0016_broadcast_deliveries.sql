-- Corrige o reprocessamento de broadcasts (item de backlog: envio duplicado
-- pro público inteiro quando um disparo trava em "sending" por >10min e é
-- resgatado de volta pra "pending" — process-broadcasts.use-case.ts).
--
-- broadcast_deliveries: registro por lead de um envio já efetivado, escopado
-- pela ocorrência (occurrence_at = scheduled_at capturado no claim — estável
-- durante retries da MESMA ocorrência, muda a cada disparo de recorrência).
-- sendBroadcast consulta essa tabela antes de enviar a cada lead e insere (ON
-- CONFLICT DO NOTHING) após o envio ter sucesso; um resgate que retoma o
-- processamento pula quem já está aqui em vez de reenviar pra audiência
-- inteira.
CREATE TABLE IF NOT EXISTS "broadcast_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_message_id" uuid NOT NULL,
	"occurrence_at" timestamp with time zone NOT NULL,
	"lead_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_scheduled_message_id_scheduled_messages_id_fk" FOREIGN KEY ("scheduled_message_id") REFERENCES "public"."scheduled_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_deliveries_message_occurrence_lead_unique" ON "broadcast_deliveries" USING btree ("scheduled_message_id", "occurrence_at", "lead_id");
