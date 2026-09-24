-- Revisão do PR #60 (remarketing): 401 (token do bot revogado/trocado) fazia
-- o processador de remarketing martelar a API do Telegram pra CADA lead
-- devido daquele bot, sempre falhando, sem ninguém do lado do dono saber.
-- Esta coluna guarda quando o dono foi avisado pela última vez pra que o
-- processador (process-remarketing.use-case.ts) não avise de novo antes de
-- 24h — sem isto, cada tick reenviaria o push.
--
-- Nenhum dado existente é alterado: coluna nova, nullable, sem default além
-- de NULL (bot nunca notificado).
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "token_invalid_notified_at" timestamp with time zone;
