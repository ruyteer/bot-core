import { secret } from "encore.dev/config";

export const encryptionKey    = secret("ENCRYPTION_KEY");
export const supabaseUrl      = secret("SUPABASE_URL");
export const encoreExternalUrl = secret("ENCORE_EXTERNAL_URL");
