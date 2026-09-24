-- Achado da auditoria (runner do funil de FLUXO): `lead_progress` não tinha
-- nenhuma restrição de unicidade, e o pubsub que entrega updates do Telegram
-- pro runner é at-least-once (retry de webhook, duas réplicas) — o mesmo
-- update processado duas vezes inseria DOIS progressos para o mesmo lead
-- (ExecuteFlowStepUseCase.startFunnelForLead fazia check-then-act: SELECT sem
-- match → INSERT, sem lock nem constraint entre os dois).

-- Dedupe de update do Telegram por bot. `update_id` é sequencial só DENTRO do
-- bot, daí a chave composta. Criada ANTES do bloco de fusão de lead_progress
-- abaixo (sem dependência entre as duas — só pra o boot não ficar com metade
-- do trabalho feito se um statement no meio falhar).
CREATE TABLE IF NOT EXISTS "processed_telegram_updates" (
  "bot_id"     uuid NOT NULL,
  "update_id"  bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "processed_telegram_updates_bot_id_update_id_pk" PRIMARY KEY ("bot_id", "update_id")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "processed_telegram_updates" ADD CONSTRAINT "processed_telegram_updates_bot_id_bots_id_fk"
    FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Pra poda periódica (runner.ts, cleanupProcessedTelegramUpdates) não virar
-- seq scan numa tabela que só cresce.
CREATE INDEX IF NOT EXISTS "processed_telegram_updates_created_at_idx"
  ON "processed_telegram_updates" ("created_at");--> statement-breakpoint

-- Achado 3: motivo (só diagnóstico) de o lead ter ficado parado num beco sem
-- saída do funil (execute-flow-step.use-case.ts). Nunca lido pelo runner —
-- `status` continua regendo o comportamento.
ALTER TABLE "lead_progress" ADD COLUMN IF NOT EXISTS "stall_reason" text;--> statement-breakpoint

-- ATENÇÃO DONO: o bloco abaixo FUNDE duplicatas de lead_progress já
-- existentes em produção antes de criar o índice único — não dá pra criar o
-- índice com dado duplicado. Critério de desempate igual ao de
-- lead-analytics.ts (linha "mais avançada" do lead): progresso com nó atual
-- ainda setado (não terminou, não está no meio de um delay) vence; empate por
-- updated_at mais recente. Delays pendentes e pagamentos das linhas
-- descartadas são REAPONTADOS pro vencedor (não perdem o timeout nem o
-- contexto de retomada) antes de a linha perdedora ser apagada. Rode antes,
-- só leitura, pra saber o tamanho do impacto:
--   SELECT lead_id, count(*) FROM lead_progress GROUP BY lead_id HAVING count(*) > 1;
--
-- Dedupe + CREATE UNIQUE INDEX andam num ÚNICO DO $$, com um LOCK TABLE
-- antes: sem o lock, entre o SELECT que monta a fusão e o CREATE INDEX no fim
-- deste MESMO statement, uma réplica antiga do runner (rodando o binário
-- anterior ao upsert atômico) podia inserir um progresso duplicado no meio do
-- caminho — o índice falharia ao criar, e daí em diante TODO onConflict do
-- código novo passaria a lançar unique_violation em vez de resolver o upsert.
-- SHARE ROW EXCLUSIVE deixa leitura concorrente livre e só bloqueia escrita
-- em lead_progress até o commit deste bloco.
--
-- Este statement inteiro é seguro de rodar de novo (ex.: reaplicado no boot
-- pelo ensure-schema.ts): o `IF NOT EXISTS (... pg_indexes ...)` faz tudo
-- virar no-op (sem nem tomar o lock) assim que o índice existir.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'lead_progress_lead_id_unique'
  ) THEN
    LOCK TABLE lead_progress IN SHARE ROW EXCLUSIVE MODE;

    CREATE TEMP TABLE IF NOT EXISTS _lp_dedupe AS
    SELECT lp.id, lp.lead_id,
           row_number() OVER (
             PARTITION BY lp.lead_id
             ORDER BY (lp.current_node_id IS NOT NULL) DESC, lp.updated_at DESC, lp.id
           ) AS rn
    FROM lead_progress lp;

    UPDATE scheduled_delays sd SET progress_id = k.id
    FROM _lp_dedupe k JOIN _lp_dedupe l ON k.lead_id = l.lead_id
    WHERE k.rn = 1 AND l.rn > 1 AND sd.progress_id = l.id;

    UPDATE payments p SET progress_id = k.id
    FROM _lp_dedupe k JOIN _lp_dedupe l ON k.lead_id = l.lead_id
    WHERE k.rn = 1 AND l.rn > 1 AND p.progress_id = l.id;

    DELETE FROM lead_progress lp
    USING _lp_dedupe d
    WHERE lp.id = d.id AND d.rn > 1;

    DROP TABLE _lp_dedupe;

    CREATE UNIQUE INDEX "lead_progress_lead_id_unique" ON "lead_progress" USING btree ("lead_id");
  END IF;
END $$;
