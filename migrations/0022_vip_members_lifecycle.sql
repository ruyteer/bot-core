-- Achado crítico da auditoria: assinatura VIP não expira e `vip_members`
-- nunca é preenchida (a entrega de convite de grupo acontecia, mas ninguém
-- gravava quem entrou nem por quanto tempo). Esta migration adiciona o que
-- falta pro ciclo de vida completo: quem, qual grupo (já existia), qual
-- compra concedeu o acesso, e quando expira.
--
-- `access_days`/`expires_at` nulos = vitalício (oferta sem prazo, mesma
-- convenção de `funnel_offers.access_days` usada em runtime: 0/ausente vira
-- "sem expire_date" no convite do Telegram).
--
-- `expired_at` é gravado pelo job de expiração do runner (ver
-- services/runner/application/vip-expiration.ts) quando o membro é
-- banido+desbanido do grupo por vencimento. É a coluna que o gatilho
-- `vip_expired` do remarketing (hoje marcado "não suportado" em
-- process-remarketing.use-case.ts) pode passar a consultar.
--
-- `expire_claimed_at` é o claim atômico do job — mesmo truque de `execute_at`
-- em `scheduled_delays`: evita duas réplicas do runner processando o mesmo
-- membro vencido ao mesmo tempo.
ALTER TABLE "vip_members" ADD COLUMN IF NOT EXISTS "access_days" integer;
ALTER TABLE "vip_members" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "vip_members" ADD COLUMN IF NOT EXISTS "expired_at" timestamp with time zone;
ALTER TABLE "vip_members" ADD COLUMN IF NOT EXISTS "expire_claimed_at" timestamp with time zone;
ALTER TABLE "vip_members" ADD COLUMN IF NOT EXISTS "payment_id" uuid;
ALTER TABLE "vip_members" ADD COLUMN IF NOT EXISTS "offer_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "vip_members" ADD CONSTRAINT "vip_members_payment_id_payments_id_fk"
    FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "vip_members" ADD CONSTRAINT "vip_members_offer_id_funnel_offers_id_fk"
    FOREIGN KEY ("offer_id") REFERENCES "public"."funnel_offers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- Renovação (nova compra do mesmo lead no mesmo grupo) estende/reativa a
-- mesma linha em vez de duplicar — ver registerOrRenewVipMembership. Parcial
-- porque group_id é opcional (config de grupo apagada/órfã não deduplica).
CREATE UNIQUE INDEX IF NOT EXISTS "vip_members_bot_group_chat_unique"
  ON "vip_members" USING btree ("bot_id", "group_id", "telegram_chat_id")
  WHERE "group_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vip_members_expires_at_idx"
  ON "vip_members" USING btree ("expires_at")
  WHERE "expires_at" IS NOT NULL AND "expired_at" IS NULL;
