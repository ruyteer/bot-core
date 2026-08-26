-- Fecha a janela de corrida do saque de comissão: requestWithdrawal
-- (referrals.api.ts) fazia check-then-act sem lock nem transação (SELECT de
-- saque "pending" existente → INSERT do novo saque). Duas requisições
-- concorrentes do mesmo usuário (double-tap no botão de saque, ou reenvio de
-- rede) liam "sem pendente" antes de qualquer uma inserir e geravam DOIS
-- saques "pending" pro mesmo user_id. Índice único parcial: só um "pending"
-- por user_id por vez — pago/rejeitado libera pra um novo saque.
CREATE UNIQUE INDEX "referral_withdrawals_pending_user_unique" ON "referral_withdrawals" USING btree ("user_id") WHERE "referral_withdrawals"."status" = 'pending';
