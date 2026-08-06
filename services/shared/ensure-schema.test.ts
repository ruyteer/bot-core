import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { ensureSchema } from "./ensure-schema.js";

describe("ensureSchema (bootstrap de DDL no boot)", () => {
  it("é idempotente: roda em cima de schema já migrado sem erro, e a coluna existe", async () => {
    const db = await testDb();
    // PGlite já aplicou migrations/*.sql (incluindo a 0004) — rodar de novo não pode falhar.
    await ensureSchema();
    await ensureSchema();
    const res = await db.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'bots' and column_name = 'default_gateway_id'
    `);
    expect(res.rows.length).toBe(1);
  });
});
