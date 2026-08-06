// Banco de testes: PGlite (Postgres real em memória) + Drizzle, injetado no
// singleton `db` via `__setTestDb`. Aplica as migrações reais do projeto, então
// testa o MESMO SQL/schema que roda em produção — sem Docker nem Postgres externo.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../../services/shared/schema/index.js";
import { __setTestDb } from "../../services/shared/database.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

let client: PGlite | undefined;
let drizzleDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

async function applyMigrations(pg: PGlite): Promise<void> {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const raw = readFileSync(join(migrationsDir, file), "utf8");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pg.exec(stmt);
    }
  }
}

/** Inicializa o DB de teste uma vez por arquivo de teste. Idempotente. */
export async function initTestDb(): Promise<ReturnType<typeof drizzle<typeof schema>>> {
  if (!drizzleDb) {
    client = new PGlite();
    await applyMigrations(client);
    drizzleDb = drizzle(client, { schema });
    __setTestDb(drizzleDb as unknown as Parameters<typeof __setTestDb>[0]);
  }
  return drizzleDb;
}

/** Limpa todos os dados entre testes, preservando o schema. */
export async function resetTestDb(): Promise<void> {
  const d = await initTestDb();
  const rows = await d.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const names = (rows.rows ?? []).map((r) => `"${r.tablename}"`);
  if (names.length > 0) {
    await d.execute(sql.raw(`TRUNCATE ${names.join(", ")} RESTART IDENTITY CASCADE`));
  }
}

/** Acesso direto ao Drizzle de teste (mesmo objeto que o `db` do app resolve). */
export async function testDb(): Promise<ReturnType<typeof drizzle<typeof schema>>> {
  return initTestDb();
}
