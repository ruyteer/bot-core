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
