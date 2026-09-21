import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { ensureSchema, isConnectionError } from "./ensure-schema.js";

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
