-- Auditoria do backend (24/09) — dois achados:
--
-- 1) Faltam índices nas tabelas que o runner consulta a cada tick (3s/60s) e a
--    cada update do Telegram. Sem eles, cada tick faz sequential scan (+ sort,
--    nos casos com ORDER BY) em tabelas que só crescem — o comentário em
--    services/runner/runner.ts sobre os 105.977 delays represados no incidente
--    de 429 (2026-08-07) é o exemplo do que um scan desses custa em produção.
--    CONCURRENTLY nas tabelas grandes/quentes (não pode rodar dentro de
--    transação — confirmado: cada statement deste bootstrap roda isolado via
--    services/shared/ensure-schema.ts, sem BEGIN/COMMIT em volta).
--
-- 2) tracking_pixels não tinha unicidade por (bot_id, provider) — dava pra
--    cadastrar o mesmo provider duas vezes no mesmo bot (bots.api.ts,
--    upsertPixel fazia select-então-insert/update sem lock: duas chamadas PUT
--    concorrentes liam "não existe" e as duas inseriam). Ver dedup ANTES do
--    índice, destacado abaixo — é destrutivo se houver duplicata.

-- ── 1) Índices de tick/hot-path ────────────────────────────────────────────

-- scheduled_delays: runner.ts:78-89, claim atômico do tick RÁPIDO (a cada 3s)
--   — "WHERE status='pending' AND execute_at<=now() ORDER BY execute_at LIMIT
--   40 FOR UPDATE SKIP LOCKED". Também serve runner.ts:198-203 (recuperação de
--   delay preso em 'processing' há >10min, tick lento). Tabela com histórico
--   de mais de 100k linhas já visto em produção — sem índice, sort completo a
--   cada 3 segundos.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_delays_status_execute_at_idx"
  ON "scheduled_delays" ("status", "execute_at");--> statement-breakpoint

-- simplified_scheduled_tasks: execute-simplified-funnel.use-case.ts:552-554,
--   processDueTasks — "WHERE status='pending' AND execute_at<=now()", chamado
--   pelo tick LENTO (60s) do funil simplificado (runner.ts:290).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "simplified_scheduled_tasks_status_execute_at_idx"
  ON "simplified_scheduled_tasks" ("status", "execute_at");--> statement-breakpoint

-- scheduled_messages (disparos/broadcasts): process-broadcasts.use-case.ts:
--   171-172, candidatos a disparo — "WHERE status='pending' AND
--   scheduled_at<=now() LIMIT 5", chamado pelo tick LENTO (runner.ts:291).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_messages_status_scheduled_at_idx"
  ON "scheduled_messages" ("status", "scheduled_at");--> statement-breakpoint

-- remarketing_lead_state: process-remarketing.use-case.ts:153-154, fila de
--   envio — "WHERE status='active' AND next_send_at<=now() LIMIT 50",
--   chamado pelo tick LENTO (runner.ts:293). Uma linha por (lead, campanha
--   ativa) — cresce proporcional a leads x campanhas.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "remarketing_lead_state_status_next_send_at_idx"
  ON "remarketing_lead_state" ("status", "next_send_at");--> statement-breakpoint

-- conversion_events (pixels): services/bots/application/pixel-events.ts:
--   225-233, processPendingConversionEvents — "WHERE status='pending' ORDER
--   BY created_at ASC LIMIT 25 FOR UPDATE SKIP LOCKED", chamado pelo tick
--   LENTO (runner.ts:295). Uma linha por evento de conversão por pixel ativo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversion_events_status_created_at_idx"
  ON "conversion_events" ("status", "created_at");--> statement-breakpoint

-- payments.external_id: services/payments/infrastructure/payment.drizzle.
--   repository.ts:157-163 (findByExternalId) e :173-181 (findByAnyExternalId)
--   — consultadas em TODO webhook de confirmação de pagamento (o caminho mais
--   quente do produto: é o que aprova a venda). Sem índice, cada webhook fazia
--   sequential scan na tabela de pagamentos inteira.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_external_id_idx"
  ON "payments" ("external_id");--> statement-breakpoint

-- payments (bot_id, status, created_at): process-broadcasts.use-case.ts:75
--   (compradores do bot, filtro de audiência) e :80 (compradores de uma oferta
--   específica); process-remarketing.use-case.ts:66-67 e :71-72 (elegibilidade
--   dos gatilhos "pix não pago" / "comprou"), todas rodando a cada disparo
--   avaliado no tick LENTO. status='paid'/'pending' filtra bem antes de
--   qualquer scan pelo prefixo (bot_id, status); created_at cobre o corte de
--   tempo do gatilho "pix não pago".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payments_bot_id_status_created_at_idx"
  ON "payments" ("bot_id", "status", "created_at");--> statement-breakpoint

-- leads (bot_id, updated_at): process-remarketing.use-case.ts:76-77, gatilho
--   de inatividade — "WHERE bot_id IN (...) AND updated_at<cutoff". Aviso:
--   leads.updated_at muda a quase toda mensagem recebida (onConflictDoUpdate
--   do /start e de cada update do Telegram), então este índice tem custo de
--   escrita real — mas sem ele o gatilho de inatividade faz sequential scan em
--   TODA a tabela de leads do bot a cada tick de 60s enquanto a campanha
--   estiver ativa, o que é pior.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "leads_bot_id_updated_at_idx"
  ON "leads" ("bot_id", "updated_at");--> statement-breakpoint

-- lead_messages (lead_id, created_at): services/leads/infrastructure/
--   lead.drizzle.repository.ts:189-193, getMessages (histórico de conversa do
--   lead, "WHERE lead_id=$1 ORDER BY created_at LIMIT 100"). Tabela recebe 1
--   linha por mensagem inbound E outbound (execute-flow-step.use-case.ts:580
--   e :584) — é uma das que mais cresce no sistema.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "lead_messages_lead_id_created_at_idx"
  ON "lead_messages" ("lead_id", "created_at");--> statement-breakpoint

-- Não criado: índice único de lead_progress — reservado ao agente
-- runner-funil-flow (fora de escopo desta migration).
-- Não criado: índice novo para leads (bot_id, telegram_chat_id) — já coberto
-- pelo unique index "leads_bot_telegram_unique" (migração 0000), que é
-- exatamente o padrão de consulta usado no upsert de lead por bot+chat
-- (execute-flow-step.use-case.ts:808) e no dedupe de audiência de broadcast
-- (process-broadcasts.use-case.ts:73, prefixo bot_id + range em
-- telegram_chat_id > 0 — o mesmo índice atende via index range scan).

-- ── 2) tracking_pixels: unicidade por (bot_id, provider) ──────────────────

-- DESTRUTIVO — leia antes do merge: esta migration não teve como confirmar
-- dado de produção (este ambiente não tem acesso ao banco). O código antigo
-- de upsertPixel (services/bots/bots.api.ts) fazia select-então-insert/update
-- sem lock nem constraint, então É POSSÍVEL que existam hoje duas linhas de
-- tracking_pixels para o mesmo (bot_id, provider). A query abaixo é
-- defensiva: se existir duplicata, mantém só a linha mais recentemente
-- atualizada de cada (bot_id, provider) e APAGA as demais. Nenhuma outra
-- tabela referencia tracking_pixels.id por FK (conversion_events casa por
-- bot_id+provider, não por id) — apagar a duplicata não derruba histórico de
-- eventos. Se produção não tiver duplicata (caso mais provável — o painel só
-- expõe um card por provider), esta query não afeta nenhuma linha.
DELETE FROM "tracking_pixels" t
  USING (
    SELECT id, row_number() OVER (
      PARTITION BY bot_id, provider
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rn
    FROM "tracking_pixels"
  ) ranked
  WHERE t.id = ranked.id AND ranked.rn > 1;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tracking_pixels_bot_id_provider_unique"
  ON "tracking_pixels" ("bot_id", "provider");
