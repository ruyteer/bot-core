-- Corrige duplicidade de envios do remarketing: hoje é possível existir mais de uma
-- linha de estado para o mesmo (campaign_id, lead_id), então dois processos concorrentes
-- (replicas do runner, ou enroll manual + gatilho automático) acabam enviando a mesma
-- campanha duas vezes para o mesmo lead.
--
-- 1) Remove as duplicatas já existentes em produção, mantendo apenas a linha mais
--    relevante por par (campaign_id, lead_id): a atualizada mais recentemente
--    (updated_at) é a que melhor reflete o progresso real do lead na campanha; em
--    empate, prioriza quem está mais avançado no ciclo (cycles_completed,
--    next_message_index) e por fim a mais antiga criada (created_at) como desempate
--    determinístico.
-- 2) Cria a constraint UNIQUE que impede a recorrência do problema.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "campaign_id", "lead_id"
      ORDER BY "updated_at" DESC, "cycles_completed" DESC, "next_message_index" DESC, "created_at" DESC, "id" DESC
    ) AS rn
  FROM "remarketing_lead_state"
)
DELETE FROM "remarketing_lead_state"
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);
--> statement-breakpoint
ALTER TABLE "remarketing_lead_state" ADD CONSTRAINT "remarketing_lead_state_campaign_id_lead_id_key" UNIQUE("campaign_id","lead_id");
