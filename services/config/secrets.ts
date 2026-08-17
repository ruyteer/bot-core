import { secret } from "encore.dev/config";

export const encryptionKey    = secret("ENCRYPTION_KEY");
export const supabaseUrl      = secret("SUPABASE_URL");
// Service role key do Supabase — acesso admin total (bypassa RLS). Usada só
// pra gerar o link de sessão da impersonação (POST /admin/users/:id/impersonate).
// NUNCA exposta ao frontend; fica só no processo do backend.
export const supabaseServiceRoleKey = secret("SUPABASE_SERVICE_ROLE_KEY");
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
// BuckPay identifica o recebedor do split por E-MAIL cadastrado na Buck (não user_id).
export const buckpaySplitEmail   = secret("BUCKPAY_SPLIT_EMAIL");

// Storage de mídia (Railway Bucket, S3-compatível) — substitui o Supabase Storage.
export const mediaS3Endpoint  = secret("MEDIA_S3_ENDPOINT");
export const mediaS3Region    = secret("MEDIA_S3_REGION");
export const mediaS3Bucket    = secret("MEDIA_S3_BUCKET");
export const mediaS3AccessKey = secret("MEDIA_S3_ACCESS_KEY");
export const mediaS3SecretKey = secret("MEDIA_S3_SECRET_KEY");
