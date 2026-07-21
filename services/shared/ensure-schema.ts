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
