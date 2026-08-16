// Migração única: copia os arquivos que já estão no Supabase Storage
// (buckets `funnel-media` e `notification-images`) pro bucket novo no Railway,
// e reescreve toda URL antiga salva no banco pra apontar pro novo storage.
//
// Roda FORA do runtime do Encore (script standalone) — por isso lê tudo de
// process.env diretamente, sem passar por services/config/secrets.ts (que
// depende do binário nativo do Encore, indisponível aqui).
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   MEDIA_S3_ENDPOINT=... MEDIA_S3_REGION=... MEDIA_S3_BUCKET=... \
//   MEDIA_S3_ACCESS_KEY=... MEDIA_S3_SECRET_KEY=... \
//   ENCORE_EXTERNAL_URL=https://bot-core-production-93cd.up.railway.app \
//   DATABASE_URL=... \
//   npx tsx scripts/migrate-supabase-storage.ts             # dry-run (só reporta)
//   npx tsx scripts/migrate-supabase-storage.ts --commit     # aplica de verdade
//
// Idempotente: pula objeto já existente na chave de destino, pula linha sem
// mais nenhuma ocorrência do prefixo antigo. Pode rodar de novo sem duplicar
// trabalho nem sobrescrever o que já foi migrado.

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

const COMMIT = process.argv.includes("--commit");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const ENCORE_EXTERNAL_URL = requireEnv("ENCORE_EXTERNAL_URL").replace(/\/+$/, "");

const s3 = new S3Client({
  endpoint: requireEnv("MEDIA_S3_ENDPOINT"),
  region:   requireEnv("MEDIA_S3_REGION"),
  credentials: {
    accessKeyId:     requireEnv("MEDIA_S3_ACCESS_KEY"),
    secretAccessKey: requireEnv("MEDIA_S3_SECRET_KEY"),
  },
});
const MEDIA_S3_BUCKET = requireEnv("MEDIA_S3_BUCKET");

const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
const db = drizzle(pool);

// ── Supabase Storage (origem) ───────────────────────────────────────────────

interface SbEntry { name: string; id: string | null; metadata: { size?: number; mimetype?: string } | null }

async function sbList(bucket: string, prefix: string): Promise<SbEntry[]> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ prefix, limit: 1000, sortBy: { column: "name", order: "asc" } }),
  });
  if (!res.ok) throw new Error(`Supabase list falhou (${bucket}/${prefix}): ${res.status} ${await res.text()}`);
  return res.json() as Promise<SbEntry[]>;
}

// Lista recursiva: entradas com id=null são "pastas" (o list do Supabase não é recursivo).
async function sbListAllFiles(bucket: string, prefix = ""): Promise<string[]> {
  const entries = await sbList(bucket, prefix);
  const paths: string[] = [];
  for (const e of entries) {
    if (e.id === null) {
      paths.push(...await sbListAllFiles(bucket, `${prefix}${e.name}/`));
    } else {
      paths.push(`${prefix}${e.name}`);
    }
  }
  return paths;
}

async function sbDownload(bucket: string, path: string): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase download falhou (${bucket}/${path}): ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  return { buffer, contentType };
}

// ── Railway Bucket (destino) ────────────────────────────────────────────────

async function destExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: MEDIA_S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function destPut(key: string, buffer: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: MEDIA_S3_BUCKET, Key: key, Body: buffer, ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
  }));
}

// ── Cópia dos buckets ────────────────────────────────────────────────────────

interface BucketMigration { supabaseBucket: string; keyPrefix: string }
const BUCKETS: BucketMigration[] = [
  { supabaseBucket: "funnel-media", keyPrefix: "" },              // mesma chave relativa
  { supabaseBucket: "notification-images", keyPrefix: "notifications/" },
];

async function migrateBuckets(): Promise<{ oldPrefix: string; newPrefix: string }[]> {
  const prefixPairs: { oldPrefix: string; newPrefix: string }[] = [];

  for (const b of BUCKETS) {
    const oldPrefix = `${SUPABASE_URL}/storage/v1/object/public/${b.supabaseBucket}/`;
    const newPrefix = `${ENCORE_EXTERNAL_URL}/media/${b.keyPrefix}`;
    prefixPairs.push({ oldPrefix, newPrefix });

    console.log(`\n=== ${b.supabaseBucket} ===`);
    const files = await sbListAllFiles(b.supabaseBucket);
    console.log(`${files.length} arquivo(s) encontrado(s) no Supabase.`);

    let copied = 0, skipped = 0, failed = 0;
    for (const path of files) {
      const destKey = `${b.keyPrefix}${path}`;
      if (await destExists(destKey)) { skipped++; continue; }
      if (!COMMIT) { copied++; continue; } // dry-run: conta como "seria copiado"
      try {
        const { buffer, contentType } = await sbDownload(b.supabaseBucket, path);
        await destPut(destKey, buffer, contentType);
        copied++;
      } catch (err) {
        failed++;
        console.error(`  FALHOU: ${path} —`, err);
      }
    }
    console.log(`${b.supabaseBucket}: ${copied} copiado(s), ${skipped} já existia(m), ${failed} falha(s).`);
  }

  return prefixPairs;
}

// ── Reescrita das URLs no banco ─────────────────────────────────────────────

function rewriteString(value: string, pairs: { oldPrefix: string; newPrefix: string }[]): string {
  let out = value;
  for (const { oldPrefix, newPrefix } of pairs) out = out.split(oldPrefix).join(newPrefix);
  return out;
}

interface JsonbTarget { table: string; idCol: string; col: string }
const JSONB_TARGETS: JsonbTarget[] = [
  { table: "funnel_nodes",         idCol: "id", col: "content" },
  { table: "funnels",              idCol: "id", col: "simplified_config" },
  { table: "remarketing_messages", idCol: "id", col: "media" },
  { table: "scheduled_messages",   idCol: "id", col: "advanced_filters" },
  { table: "broadcast_runs",       idCol: "id", col: "filter_snapshot" },
  { table: "broadcast_runs",       idCol: "id", col: "metadata" },
];

interface TextTarget { table: string; idCol: string; col: string }
const TEXT_TARGETS: TextTarget[] = [
  { table: "admin_notifications", idCol: "id", col: "image_url" },
  { table: "funnel_offers",       idCol: "id", col: "delivery_url" }, // defensivo — raramente aponta pro Supabase, mas não custa checar
];

// Nomes de tabela/coluna vêm só das listas fixas acima (nunca de input
// externo) — sql.raw() neles é seguro. Valores (padrão de busca, conteúdo
// reescrito, id) sempre passam pelo binding parametrizado do drizzle.
async function rewriteJsonbTargets(pairs: { oldPrefix: string; newPrefix: string }[]): Promise<void> {
  for (const t of JSONB_TARGETS) {
    const idIdent  = sql.raw(`"${t.idCol}"`);
    const colIdent = sql.raw(`"${t.col}"`);
    const tableIdent = sql.raw(`"${t.table}"`);
    const likePattern = `%${pairs[0].oldPrefix}%`;

    const result = await db.execute(
      sql`SELECT ${idIdent} AS id, ${colIdent} AS val FROM ${tableIdent} WHERE ${colIdent}::text LIKE ${likePattern}`
    );
    const list = result.rows as Array<{ id: unknown; val: unknown }>;
    if (list.length === 0) continue;

    console.log(`${t.table}.${t.col}: ${list.length} linha(s) com URL antiga.`);
    for (const row of list) {
      const id = row.id;
      const raw = JSON.stringify(row.val);
      const rewritten = rewriteString(raw, pairs);
      if (rewritten === raw) continue;
      if (!COMMIT) continue;
      await db.execute(
        sql`UPDATE ${tableIdent} SET ${colIdent} = ${rewritten}::jsonb WHERE ${idIdent} = ${id}`
      );
    }
  }
}

async function rewriteTextTargets(pairs: { oldPrefix: string; newPrefix: string }[]): Promise<void> {
  for (const t of TEXT_TARGETS) {
    const idIdent  = sql.raw(`"${t.idCol}"`);
    const colIdent = sql.raw(`"${t.col}"`);
    const tableIdent = sql.raw(`"${t.table}"`);
    const likePattern = `%${pairs[0].oldPrefix}%`;

    const result = await db.execute(
      sql`SELECT ${idIdent} AS id, ${colIdent} AS val FROM ${tableIdent} WHERE ${colIdent} LIKE ${likePattern}`
    );
    const list = result.rows as Array<{ id: unknown; val: unknown }>;
    if (list.length === 0) continue;

    console.log(`${t.table}.${t.col}: ${list.length} linha(s) com URL antiga.`);
    for (const row of list) {
      const id = row.id;
      const raw = String(row.val ?? "");
      const rewritten = rewriteString(raw, pairs);
      if (rewritten === raw) continue;
      if (!COMMIT) continue;
      await db.execute(
        sql`UPDATE ${tableIdent} SET ${colIdent} = ${rewritten} WHERE ${idIdent} = ${id}`
      );
    }
  }
}

async function main() {
  console.log(COMMIT ? "*** MODO --commit: vai gravar de verdade ***" : "*** dry-run (nada será escrito — rode com --commit pra aplicar) ***");

  const pairs = await migrateBuckets();

  console.log("\n=== Reescrita de URLs no banco ===");
  await rewriteJsonbTargets(pairs);
  await rewriteTextTargets(pairs);

  console.log("\nConcluído.");
  await pool.end();
}

main().catch((err) => { console.error("FALHOU:", err); process.exit(1); });
