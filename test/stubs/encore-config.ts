// Stub de `encore.dev/config` para os testes (aliased no vitest.config.ts).
// O `secret()` do Encore só funciona dentro do runtime; aqui devolvemos valores
// de teste determinísticos (ou de env, se setado) para o código que lê segredos.

const DEFAULTS: Record<string, string> = {
  // Chave AES-256-GCM de teste (32 bytes = 64 hex). NÃO é a de produção.
  ENCRYPTION_KEY: "0".repeat(64),
  SUPABASE_URL: "https://test.supabase.local",
  ENCORE_EXTERNAL_URL: "https://test.orionbot.local",
  DATABASE_URL: "postgres://test/test",
};

export function secret(name: string): () => string {
  return () => process.env[`TEST_SECRET_${name}`] ?? DEFAULTS[name] ?? "";
}
