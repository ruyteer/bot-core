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

  // 0009_tracking_clicks.sql
  `CREATE TABLE IF NOT EXISTS "tracking_clicks" (
     "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "token"        text NOT NULL,
     "bot_id"       uuid NOT NULL,
     "platform"     text,
     "utm_source"   text,
     "utm_medium"   text,
     "utm_campaign" text,
     "utm_content"  text,
     "utm_term"     text,
     "fbclid"       text,
     "gclid"        text,
     "ttclid"       text,
     "client_ip"    text,
     "user_agent"   text,
     "lead_id"      uuid,
     "consumed_at"  timestamp with time zone,
     "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
     CONSTRAINT "tracking_clicks_token_key" UNIQUE ("token")
   )`,
  `DO $$ BEGIN
     ALTER TABLE "tracking_clicks" ADD CONSTRAINT "tracking_clicks_bot_id_bots_id_fk"
       FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "tracking_clicks" ADD CONSTRAINT "tracking_clicks_lead_id_leads_id_fk"
       FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE set null ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE INDEX IF NOT EXISTS "tracking_clicks_bot_id_created_at_idx" ON "tracking_clicks" ("bot_id", "created_at")`,

  // 0010_kwai_click_id.sql
  `ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "kwai_click_id" text`,
  `ALTER TABLE "tracking_clicks" ADD COLUMN IF NOT EXISTS "kwai_click_id" text`,

  // 0011_remarketing_lead_state_unique.sql — corrige remarketing duplicado:
  // remove duplicatas existentes por (campaign_id, lead_id) mantendo a linha mais
  // relevante (updated_at mais recente, depois mais avançada no ciclo, depois mais
  // antiga criada como desempate) e cria a constraint única que impede recorrência.
  `WITH ranked AS (
     SELECT "id", ROW_NUMBER() OVER (
       PARTITION BY "campaign_id", "lead_id"
       ORDER BY "updated_at" DESC, "cycles_completed" DESC, "next_message_index" DESC, "created_at" DESC, "id" DESC
     ) AS rn
     FROM "remarketing_lead_state"
   )
   DELETE FROM "remarketing_lead_state" WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1)`,
  // UNIQUE cria um índice implícito com o mesmo nome da constraint: se esse
  // índice já existe (ex.: boot anterior já criou a constraint), o Postgres
  // falha ao tentar recriá-lo com duplicate_table (42P07, "relation already
  // exists"), não duplicate_object (42710) — precisa capturar os dois.
  `DO $$ BEGIN
     ALTER TABLE "remarketing_lead_state" ADD CONSTRAINT "remarketing_lead_state_campaign_id_lead_id_key"
       UNIQUE ("campaign_id", "lead_id");
   EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$`,

  // 0012_processed_webhooks_status_key.sql — idempotência de webhook passa a
  // considerar o status (external_id, provider, status), não só (external_id,
  // provider). Sem isso, o primeiro webhook de uma venda (quase sempre o de
  // criação, com status pending/waiting_for_approval) travava a transação como
  // "processada" pra sempre, e o webhook de confirmação de pagamento que
  // chegava depois era descartado silenciosamente antes até de ser logado.
  `DO $$ BEGIN
     ALTER TABLE "processed_webhooks" DROP CONSTRAINT "processed_webhooks_external_id_provider_pk";
   EXCEPTION WHEN undefined_object THEN null; END $$`,
  // Mesmo risco de índice implícito do caso acima (duplicate_table), mais um
  // terceiro: PRIMARY KEY é única por tabela, então reaplicar esta constraint
  // (já existente, mesmo nome) faz o Postgres barrar antes de checar nome de
  // índice, com invalid_table_definition ("multiple primary keys ... are not
  // allowed") — precisa capturar os três.
  `DO $$ BEGIN
     ALTER TABLE "processed_webhooks" ADD CONSTRAINT "processed_webhooks_external_id_provider_status_pk"
       PRIMARY KEY ("external_id", "provider", "status");
   EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN null; END $$`,

  // 0013_remarketing_offer_style.sql — botão da oferta do remarketing também
  // pode ter cor (primary/constructive/destructive). Coluna nullable, sem
  // default: null mantém o comportamento atual (sem cor).
  `ALTER TABLE "remarketing_messages" ADD COLUMN IF NOT EXISTS "offer_style" text`,

  // 0014_payments_pending_offer_unique.sql — fecha a janela de corrida do
  // dedupe de PIX (achado de revisão de segurança): handleOfferPurchase fazia
  // check-then-act sem lock/transação entre o SELECT de "já existe pendente" e
  // o INSERT (com uma chamada de rede ao gateway no meio) — dois cliques
  // concorrentes no mesmo botão de oferta geravam dois PIX. Só um "pending" por
  // (lead_id, node_id, paid_handle) por vez.
  `CREATE UNIQUE INDEX IF NOT EXISTS "payments_pending_offer_unique"
     ON "payments" USING btree ("lead_id", "node_id", "paid_handle")
     WHERE "status" = 'pending'`,

  // 0015_referral_withdrawals_pending_unique.sql — fecha a janela de corrida
  // do saque de comissão: requestWithdrawal fazia check-then-act sem
  // lock/transação entre o SELECT de "já existe pendente" e o INSERT — duas
  // requisições concorrentes do mesmo usuário geravam dois saques "pending".
  // Só um "pending" por user_id por vez.
  `CREATE UNIQUE INDEX IF NOT EXISTS "referral_withdrawals_pending_user_unique"
     ON "referral_withdrawals" USING btree ("user_id")
     WHERE "status" = 'pending'`,

  // 0016_broadcast_deliveries.sql — corrige o reenvio pro público inteiro
  // quando um broadcast trava em "sending" >10min e é resgatado: registro por
  // lead já entregue (broadcast_deliveries), escopado por ocorrência.
  `CREATE TABLE IF NOT EXISTS "broadcast_deliveries" (
     "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
     "scheduled_message_id"  uuid NOT NULL,
     "occurrence_at"         timestamp with time zone NOT NULL,
     "lead_id"               uuid NOT NULL,
     "created_at"            timestamp with time zone DEFAULT now() NOT NULL
   )`,
  `DO $$ BEGIN
     ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_scheduled_message_id_scheduled_messages_id_fk"
       FOREIGN KEY ("scheduled_message_id") REFERENCES "scheduled_messages"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `DO $$ BEGIN
     ALTER TABLE "broadcast_deliveries" ADD CONSTRAINT "broadcast_deliveries_lead_id_leads_id_fk"
       FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE cascade ON UPDATE no action;
   EXCEPTION WHEN duplicate_object THEN null; END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_deliveries_message_occurrence_lead_unique"
     ON "broadcast_deliveries" USING btree ("scheduled_message_id", "occurrence_at", "lead_id")`,

  // 0017_scheduled_messages_client_request_id.sql — contra clique duplo em
  // POST /broadcasts e POST /broadcasts/send: chave de idempotência opcional
  // enviada pelo cliente (client_request_id), nullable e escopada por usuário.
  `ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "client_request_id" text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_messages_user_client_request_unique"
     ON "scheduled_messages" USING btree ("user_id", "client_request_id")
     WHERE "client_request_id" IS NOT NULL`,

  // 0018_profiles_email_lower_unique.sql — segurança (revisão do PR #53,
  // POST /accounts/provision): profiles.email não tinha nenhuma restrição de
  // unicidade. Fecha a janela pros dois caminhos que gravam profiles (o
  // provisionamento novo E o upsert do authHandler antigo, via JWT Supabase).
  // Produção conferida antes (só leitura): 18 perfis, zero duplicata de
  // lower(email), nenhum email nulo.
  `CREATE UNIQUE INDEX IF NOT EXISTS "profiles_email_lower_unique" ON "profiles" (lower("email"))`,

  // 0019_indices_runner_e_pixels.sql — auditoria do backend (24/09), índices
  // que faltam nas tabelas quentes do runner (tick de 3s/60s e update do
  // Telegram). CONCURRENTLY: cada statement deste bootstrap roda isolado, sem
  // BEGIN/COMMIT em volta (ver ensureSchema abaixo), então CONCURRENTLY é
  // seguro aqui. Detalhe de cada índice (arquivo:linha da consulta que atende)
  // no comentário da migration.
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_delays_status_execute_at_idx"
     ON "scheduled_delays" ("status", "execute_at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "simplified_scheduled_tasks_status_execute_at_idx"
     ON "simplified_scheduled_tasks" ("status", "execute_at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_messages_status_scheduled_at_idx"
     ON "scheduled_messages" ("status", "scheduled_at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "remarketing_lead_state_status_next_send_at_idx"
     ON "remarketing_lead_state" ("status", "next_send_at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversion_events_status_created_at_idx"
     ON "conversion_events" ("status", "created_at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_external_id_idx"
     ON "payments" ("external_id")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_bot_id_status_created_at_idx"
     ON "payments" ("bot_id", "status", "created_at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "leads_bot_id_updated_at_idx"
     ON "leads" ("bot_id", "updated_at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "lead_messages_lead_id_created_at_idx"
     ON "lead_messages" ("lead_id", "created_at")`,

  // tracking_pixels: unicidade por (bot_id, provider) — antes disto dava pra
  // cadastrar o mesmo provider duas vezes no mesmo bot (upsertPixel fazia
  // select-então-insert/update sem lock). DESTRUTIVO se já houver duplicata em
  // produção: ver comentário completo na migration 0019 — mantém só a linha
  // mais recentemente atualizada de cada (bot_id, provider) e apaga as
  // demais (nenhuma FK aponta para tracking_pixels.id).
  `DELETE FROM "tracking_pixels" t
     USING (
       SELECT id, row_number() OVER (
         PARTITION BY bot_id, provider
         ORDER BY updated_at DESC, created_at DESC, id DESC
       ) AS rn
       FROM "tracking_pixels"
     ) ranked
     WHERE t.id = ranked.id AND ranked.rn > 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "tracking_pixels_bot_id_provider_unique"
     ON "tracking_pixels" ("bot_id", "provider")`,

  // 0021_payments_confirmation.sql — confirmação de pagamento: snapshot do
  // split aplicado na criação do PIX (a confirmação não recalcula mais) e
  // guarda de entrega exatamente-uma-vez do paymentPaid (at-least-once).
  // Só colunas novas e nullable — nenhum dado existente é alterado.
  `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "split_snapshot" jsonb`,
  `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "delivery_claimed_at" timestamp with time zone`,
  `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone`,
];

export interface SchemaFailure {
  statement: string;
  error:     unknown;
}

// Erro de conexão (sem SQLSTATE, ou classe 08 / 57P = servidor caindo) vale
// retry do bootstrap inteiro. Qualquer outro erro é do próprio statement (ex.:
// índice único sobre dado duplicado) e não pode travar os seguintes — já
// aconteceu: o índice 0014 falhou e 0015–0017 ficaram sem aplicar em produção.
export function isConnectionError(err: unknown): boolean {
  type PgLike = { code?: unknown; severity?: unknown; cause?: PgLike } | null | undefined;
  const e = err as PgLike;
  // Erro vindo do servidor Postgres (DatabaseError) sempre traz `severity`;
  // erro de sistema do Node (ECONNREFUSED, EPIPE, EPERM...) nunca traz — e
  // EPIPE/EPERM têm 5 letras, então a forma do código sozinha não distingue.
  const pg = [e, e?.cause].find((x) => typeof x?.severity === "string" && typeof x?.code === "string");
  if (!pg) return true;
  const code = pg.code as string;
  return code.startsWith("08") || code.startsWith("57P");
}

// Aplica cada statement isolado: falha de um não impede os outros. Devolve as
// falhas (vazio = tudo aplicado). Erro de conexão é relançado pro retry.
export async function ensureSchema(statements: readonly string[] = STATEMENTS): Promise<SchemaFailure[]> {
  const failures: SchemaFailure[] = [];
  for (const stmt of statements) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      if (isConnectionError(err)) throw err;
      failures.push({ statement: stmt, error: err });
    }
  }
  return failures;
}

// Boot com retry: o DB do Railway às vezes recusa conexão nos primeiros
// segundos do deploy. Falha aqui não derruba o processo, mas loga alto —
// sem a coluna, os selects de bots quebram até o schema ser aplicado.
export async function ensureSchemaAtBoot(attempts = 5, delayMs = 5_000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const failures = await ensureSchema();
      if (failures.length === 0) {
        console.log("[schema] bootstrap de schema aplicado (idempotente)");
        return;
      }
      // Erro de dado/DDL não se resolve com retry: loga cada um e segue.
      for (const f of failures) {
        console.error("[schema] statement falhou (os demais foram aplicados):", f.statement.trim().split("\n")[0], f.error);
      }
      console.error(`[schema] ATENÇÃO: ${failures.length} statement(s) do bootstrap não aplicado(s) — corrigir o dado e reiniciar, ou aplicar migrations/*.sql manualmente`);
      return;
    } catch (err) {
      console.error(`[schema] tentativa ${i}/${attempts} falhou:`, err);
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error("[schema] ATENÇÃO: bootstrap de schema não foi aplicado — aplicar migrations/*.sql manualmente");
}
