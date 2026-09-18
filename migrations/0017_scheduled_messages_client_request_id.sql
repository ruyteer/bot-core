-- Contra clique duplo em POST /broadcasts e POST /broadcasts/send: chave de
-- idempotência opcional enviada pelo cliente. Uma segunda chamada com o mesmo
-- client_request_id devolve/reaproveita o disparo já criado em vez de criar
-- outro (broadcasts.api.ts, catch de isUniqueViolation). Nullable e escopado
-- por usuário — quem não manda a chave (UI antiga) não é afetado.
ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "client_request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_messages_user_client_request_unique" ON "scheduled_messages" USING btree ("user_id", "client_request_id") WHERE "scheduled_messages"."client_request_id" IS NOT NULL;
