import { sql } from "drizzle-orm";
import { db } from "./database.js";

// Não há migrator automático no self-hosted (Railway): as migrações de
// migrations/*.sql são aplicadas à mão. Isso já quebrou deploy (código lendo
// coluna que ainda não existia). Este bootstrap aplica no boot os DDLs
// IDEMPOTENTES das migrações que o código atual exige — seguro rodar sempre.
// Ao criar uma migração nova cujo código dependa dela, replicar aqui os
// statements (sempre com IF NOT EXISTS / guard de duplicate_object).
const STATEMENTS: string[] = [
  // 0004_bot_default_gateway.sql
  `ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "default_gateway_id" uuid`,
  `DO $$ BEGIN
     ALTER TABLE "bots" ADD CONSTRAINT "bots_default_gateway_id_payment_gateways_id_fk"
       FOREIGN KEY ("default_gateway_id") REFERENCES "payment_gateways"("id") ON DELETE set null ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,

  // 0005_bot_gateway_fallback.sql
  `CREATE TABLE IF NOT EXISTS "bot_payment_gateways" (
     "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "bot_id"     uuid NOT NULL,
     "gateway_id" uuid NOT NULL,
     "position"   integer DEFAULT 0 NOT NULL,
     "created_at" timestamp with time zone DEFAULT now() NOT NULL,
     CONSTRAINT "bot_payment_gateways_bot_id_gateway_id_key" UNIQUE ("bot_id", "gateway_id")
   )`,
  `DO $$ BEGIN
     ALTER TABLE "bot_payment_gateways" ADD CONSTRAINT "bot_payment_gateways_bot_id_bots_id_fk"
       FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "bot_payment_gateways" ADD CONSTRAINT "bot_payment_gateways_gateway_id_payment_gateways_id_fk"
       FOREIGN KEY ("gateway_id") REFERENCES "payment_gateways"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "bot_payment_gateways_bot_id_position_idx"
     ON "bot_payment_gateways" ("bot_id", "position")`,
  // Semeia a ordem com o gateway padrão que cada bot já tinha (não perde config).
  `INSERT INTO "bot_payment_gateways" ("bot_id", "gateway_id", "position")
   SELECT "id", "default_gateway_id", 0 FROM "bots" WHERE "default_gateway_id" IS NOT NULL
   ON CONFLICT ("bot_id", "gateway_id") DO NOTHING`,

  // 0006_lead_events.sql
  `CREATE TABLE IF NOT EXISTS "lead_events" (
     "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "bot_id"     uuid NOT NULL,
     "lead_id"    uuid,
     "kind"       text NOT NULL,
     "created_at" timestamp with time zone DEFAULT now() NOT NULL
   )`,
  `DO $$ BEGIN
     ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_bot_id_bots_id_fk"
       FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_leads_id_fk"
       FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "lead_events_bot_id_kind_created_at_idx"
     ON "lead_events" ("bot_id", "kind", "created_at")`,

  // 0007_compliance.sql
  `CREATE TABLE IF NOT EXISTS "blocked_keywords" (
     "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "keyword"    text NOT NULL,
     "category"   text DEFAULT 'geral' NOT NULL,
     "created_at" timestamp with time zone DEFAULT now() NOT NULL,
     CONSTRAINT "blocked_keywords_keyword_key" UNIQUE ("keyword")
   )`,
  `CREATE TABLE IF NOT EXISTS "compliance_alerts" (
     "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "source_type"        text NOT NULL,
     "source_id"          uuid NOT NULL,
     "user_id"            uuid,
     "keywords"           jsonb DEFAULT '[]'::jsonb NOT NULL,
     "category"           text,
     "snippet"            text,
     "status"             text DEFAULT 'pending' NOT NULL,
     "dismissed_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
     "created_at"         timestamp with time zone DEFAULT now() NOT NULL,
     "updated_at"         timestamp with time zone DEFAULT now() NOT NULL,
     CONSTRAINT "compliance_alerts_source_type_source_id_key" UNIQUE ("source_type", "source_id")
   )`,
  `DO $$ BEGIN
     ALTER TABLE "compliance_alerts" ADD CONSTRAINT "compliance_alerts_user_id_profiles_id_fk"
       FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "compliance_alerts_status_idx" ON "compliance_alerts" ("status")`,

  // 0008_referrals.sql
  `CREATE TABLE IF NOT EXISTS "referral_codes" (
     "user_id"            uuid PRIMARY KEY NOT NULL,
     "code"               text NOT NULL,
     "commission_percent" integer,
     "created_at"         timestamp with time zone DEFAULT now() NOT NULL,
     "updated_at"         timestamp with time zone DEFAULT now() NOT NULL,
     CONSTRAINT "referral_codes_code_key" UNIQUE ("code")
   )`,
  `DO $$ BEGIN
     ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_profiles_id_fk"
       FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE TABLE IF NOT EXISTS "referrals" (
     "referred_user_id" uuid PRIMARY KEY NOT NULL,
     "referrer_user_id" uuid NOT NULL,
     "created_at"       timestamp with time zone DEFAULT now() NOT NULL
   )`,
  `DO $$ BEGIN
     ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_profiles_id_fk"
       FOREIGN KEY ("referred_user_id") REFERENCES "profiles"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_profiles_id_fk"
       FOREIGN KEY ("referrer_user_id") REFERENCES "profiles"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "referrals_referrer_user_id_idx" ON "referrals" ("referrer_user_id")`,
  `CREATE TABLE IF NOT EXISTS "referral_commissions" (
     "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "referrer_user_id" uuid NOT NULL,
     "referred_user_id" uuid NOT NULL,
     "payment_id"       uuid NOT NULL,
     "base_fee_cents"   integer NOT NULL,
     "percent"          integer NOT NULL,
     "amount_cents"     integer NOT NULL,
     "created_at"       timestamp with time zone DEFAULT now() NOT NULL,
     CONSTRAINT "referral_commissions_payment_id_key" UNIQUE ("payment_id")
   )`,
  `DO $$ BEGIN
     ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_referrer_user_id_profiles_id_fk"
       FOREIGN KEY ("referrer_user_id") REFERENCES "profiles"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_referred_user_id_profiles_id_fk"
       FOREIGN KEY ("referred_user_id") REFERENCES "profiles"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_payment_id_payments_id_fk"
       FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "referral_commissions_referrer_user_id_idx" ON "referral_commissions" ("referrer_user_id")`,
  `CREATE TABLE IF NOT EXISTS "referral_withdrawals" (
     "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "user_id"      uuid NOT NULL,
     "amount_cents" integer NOT NULL,
     "pix_key"      text NOT NULL,
     "status"       text DEFAULT 'pending' NOT NULL,
     "notes"        text,
     "processed_by" uuid,
     "processed_at" timestamp with time zone,
     "created_at"   timestamp with time zone DEFAULT now() NOT NULL
   )`,
  `DO $$ BEGIN
     ALTER TABLE "referral_withdrawals" ADD CONSTRAINT "referral_withdrawals_user_id_profiles_id_fk"
       FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "referral_withdrawals" ADD CONSTRAINT "referral_withdrawals_processed_by_profiles_id_fk"
       FOREIGN KEY ("processed_by") REFERENCES "profiles"("id") ON DELETE set null ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "referral_withdrawals_status_idx" ON "referral_withdrawals" ("status")`,
];

export async function ensureSchema(): Promise<void> {
  for (const stmt of STATEMENTS) {
    await db.execute(sql.raw(stmt));
  }
}

// Boot com retry: o DB do Railway às vezes recusa conexão nos primeiros
// segundos do deploy. Falha aqui não derruba o processo, mas loga alto —
// sem a coluna, os selects de bots quebram até o schema ser aplicado.
export async function ensureSchemaAtBoot(attempts = 5, delayMs = 5_000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await ensureSchema();
      console.log("[schema] bootstrap de schema aplicado (idempotente)");
      return;
    } catch (err) {
      console.error(`[schema] tentativa ${i}/${attempts} falhou:`, err);
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error("[schema] ATENÇÃO: bootstrap de schema não foi aplicado — aplicar migrations/*.sql manualmente");
}
