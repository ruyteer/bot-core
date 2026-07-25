import { secret } from "encore.dev/config";

export const encryptionKey    = secret("ENCRYPTION_KEY");
export const supabaseUrl      = secret("SUPABASE_URL");
export const encoreExternalUrl = secret("ENCORE_EXTERNAL_URL");
export const databaseUrl       = secret("DATABASE_URL");

// Web Push (VAPID). Gerar o par com `npx web-push generate-vapid-keys`.
// A pública é servida ao frontend por GET /notifications/vapid-key; a privada
// nunca sai do backend. Sem elas, o envio de push é pulado (não quebra nada).
export const vapidPublicKey  = secret("VAPID_PUBLIC_KEY");
export const vapidPrivateKey = secret("VAPID_PRIVATE_KEY");
export const vapidSubject    = secret("VAPID_SUBJECT");

// Recebedor do split de monetização (R$0,40 por transação p/ a plataforma).
// É a CONTA DA PLATAFORMA em cada PSP, identificada pelo id de recebedor daquele
// gateway (SyncPay: client_id; NexusPag/WiinPay: user_id). Config da plataforma,
// não por usuário. Vazio = split desligado nesse provider (o PIX segue normal).
export const syncpaySplitUserId  = secret("SYNCPAY_SPLIT_USER_ID");
export const nexuspagSplitUserId = secret("NEXUSPAG_SPLIT_USER_ID");
export const wiinpaySplitUserId  = secret("WIINPAY_SPLIT_USER_ID");

// Split de monetização: R$0,40 por transação vão para a conta da PLATAFORMA em
// cada gateway. O recebedor é a conta da plataforma NO MESMO PSP, identificada
// pelo user_id/client_id abaixo (um por provider). Enquanto o secret estiver
// vazio, o split é pulado e o PIX é gerado normalmente (sem taxa da plataforma).
export const splitSyncpayUserId  = secret("SPLIT_SYNCPAY_USER_ID");
export const splitNexuspagUserId = secret("SPLIT_NEXUSPAG_USER_ID");
export const splitWiinpayUserId  = secret("SPLIT_WIINPAY_USER_ID");
