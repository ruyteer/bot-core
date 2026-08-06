CREATE TABLE IF NOT EXISTS "bot_payment_gateways" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bot_id"     uuid NOT NULL,
  "gateway_id" uuid NOT NULL,
  "position"   integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_payment_gateways_bot_id_gateway_id_key" UNIQUE ("bot_id", "gateway_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "bot_payment_gateways" ADD CONSTRAINT "bot_payment_gateways_bot_id_bots_id_fk"
    FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "bot_payment_gateways" ADD CONSTRAINT "bot_payment_gateways_gateway_id_payment_gateways_id_fk"
    FOREIGN KEY ("gateway_id") REFERENCES "payment_gateways"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_payment_gateways_bot_id_position_idx"
  ON "bot_payment_gateways" ("bot_id", "position");
--> statement-breakpoint
-- Semeia a ordem com o gateway padrão que cada bot já tinha, para ninguém perder
-- configuração ao subir esta versão.
INSERT INTO "bot_payment_gateways" ("bot_id", "gateway_id", "position")
SELECT "id", "default_gateway_id", 0 FROM "bots" WHERE "default_gateway_id" IS NOT NULL
ON CONFLICT ("bot_id", "gateway_id") DO NOTHING;
