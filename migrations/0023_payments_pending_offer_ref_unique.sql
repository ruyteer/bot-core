-- Fecha a janela de corrida do dedupe de PIX do funil SIMPLIFICADO (achado da
-- auditoria de 24/09): generatePix (execute-simplified-funnel.use-case.ts)
-- fazia check-then-act sem lock nem transação (findPendingByOfferRef → SELECT,
-- createPixWithFallback → chamada de rede ao gateway, payRepo.create → INSERT).
-- Dois cliques concorrentes no mesmo plano/upsell/downsell (duplo-toque do
-- lead, ou reentrega at-least-once do update do Telegram/pubsub do Encore)
-- liam "sem pendente" antes de qualquer um inserir e geravam DOIS PIX pra
-- mesma compra. Mesmo padrão de payments_pending_offer_unique (migration
-- 0014), só que pela chave do simplificado (lead_id, offer_external_ref) em
-- vez de (lead_id, node_id, paid_handle) do funil de fluxo. offer_external_ref
-- só é preenchido pelo simplificado — flow nunca grava esse campo, então não
-- há colisão entre os dois tipos de funil.
--
-- Produção já tem 11 grupos de (lead_id, offer_external_ref) com mais de um
-- "pending" (40 linhas a mais, achado pelo bug que esta migration fecha) — o
-- CREATE UNIQUE INDEX abaixo falharia direto nesses grupos. Antes dele: mantém
-- o "pending" mais recente de cada grupo (é o PIX que o lead tem na tela
-- agora) e marca os mais antigos como "expired" — NUNCA apaga, pagamento é
-- registro financeiro; a confirmação de pagamento aceita expired → paid, então
-- se algum desses ainda for pago no gateway a venda confirma normalmente.
-- Idempotente e barata: depois que cada grupo fica com no máximo um
-- "pending", o WHERE rn > 1 não bate mais em nada.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "lead_id", "offer_external_ref"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS rn
  FROM "payments"
  WHERE "status" = 'pending' AND "offer_external_ref" IS NOT NULL
)
UPDATE "payments" SET "status" = 'expired', "updated_at" = now()
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_pending_offer_ref_unique" ON "payments" USING btree ("lead_id","offer_external_ref") WHERE "payments"."status" = 'pending' AND "payments"."offer_external_ref" IS NOT NULL;
