ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "default_gateway_id" uuid;
DO $$ BEGIN
  ALTER TABLE "bots" ADD CONSTRAINT "bots_default_gateway_id_payment_gateways_id_fk"
    FOREIGN KEY ("default_gateway_id") REFERENCES "payment_gateways"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
