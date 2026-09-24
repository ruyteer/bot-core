import { describe, it, expect } from "vitest";
import { sql, eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { ensureSchema, isConnectionError } from "./ensure-schema.js";
import { payments } from "./schema/index.js";
import { createBot, createGateway, createLead } from "../../test/helpers/seed.js";

describe("ensureSchema (bootstrap de DDL no boot)", () => {
  it("é idempotente: roda em cima de schema já migrado sem erro, e a coluna existe", async () => {
    const db = await testDb();
    // PGlite já aplicou migrations/*.sql (incluindo a 0004) — rodar de novo não pode falhar.
    expect(await ensureSchema()).toEqual([]);
    expect(await ensureSchema()).toEqual([]);
    const res = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'bots' and column_name = 'default_gateway_id'
    `);
    expect(res.rows.length).toBe(1);
  });

  it("statement que falha por dado não impede os seguintes (caso real: índice 0014 travou 0015–0017)", async () => {
    const db = await testDb();
    await db.execute(sql`create table if not exists "schema_probe_dup" ("k" int)`);
    await db.execute(sql`insert into "schema_probe_dup" values (1), (1)`);
    const failures = await ensureSchema([
      `CREATE UNIQUE INDEX IF NOT EXISTS "schema_probe_dup_unique" ON "schema_probe_dup" ("k")`,
      `ALTER TABLE "schema_probe_dup" ADD COLUMN IF NOT EXISTS "depois" text`,
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].statement).toContain("schema_probe_dup_unique");
    const res = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'schema_probe_dup' and column_name = 'depois'
    `);
    expect(res.rows.length).toBe(1);
    await db.execute(sql`drop table "schema_probe_dup"`);
  });

  it("0023: duplicata pré-existente de (lead_id, offer_external_ref) 'pending' vira 'expired' (mantém a mais recente) e o índice único é criado", async () => {
    const db = await testDb();
    // Simula produção ANTES desta migration: dropa o índice (já aplicado pelas
    // migrations no bootstrap do PGlite) pra poder inserir a duplicata que o
    // bug de dedupe (achado 2 da auditoria) deixou pra trás.
    await db.execute(sql`DROP INDEX IF EXISTS "payments_pending_offer_ref_unique"`);

    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId });
    const leadId = await createLead(bot.id, BigInt(700 + Math.floor(Math.random() * 1e6)));
    const refKey = "funnel-x:plan:p1";

    const [older] = await db.insert(payments).values({
      userId: bot.userId, botId: bot.id, leadId, gatewayId: gwId,
      offerExternalRef: refKey, amount: 1990, status: "pending",
      createdAt: new Date(Date.now() - 60_000),
    }).returning();
    const [newer] = await db.insert(payments).values({
      userId: bot.userId, botId: bot.id, leadId, gatewayId: gwId,
      offerExternalRef: refKey, amount: 2990, status: "pending",
      createdAt: new Date(),
    }).returning();

    expect(await ensureSchema()).toEqual([]);

    const older2 = await db.select().from(payments).where(eq(payments.id, older.id));
    const newer2 = await db.select().from(payments).where(eq(payments.id, newer.id));
    expect(older2[0].status).toBe("expired"); // mais antiga: expirada, não apagada
    expect(newer2[0].status).toBe("pending"); // mais recente: continua a cobrança válida

    const idx = await db.execute(sql`
      select indexname from pg_indexes where indexname = 'payments_pending_offer_ref_unique'
    `);
    expect(idx.rows.length).toBe(1);

    // Idempotente: rodar de novo não erra e não mexe mais em nada.
    expect(await ensureSchema()).toEqual([]);
    const newer3 = await db.select().from(payments).where(eq(payments.id, newer.id));
    expect(newer3[0].status).toBe("pending");
  });

  it("isConnectionError: só erro sem SQLSTATE ou de conexão vale retry", () => {
    expect(isConnectionError(new Error("connect ECONNREFUSED"))).toBe(true);
    expect(isConnectionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isConnectionError({ code: "EPIPE" })).toBe(true);
    expect(isConnectionError({ code: "EPERM" })).toBe(true);
    expect(isConnectionError({ code: "08006", severity: "FATAL" })).toBe(true);
    expect(isConnectionError({ code: "57P01", severity: "FATAL" })).toBe(true);
    expect(isConnectionError({ code: "23505", severity: "ERROR" })).toBe(false);
    expect(isConnectionError({ cause: { code: "42P07", severity: "ERROR" } })).toBe(false);
  });
});
