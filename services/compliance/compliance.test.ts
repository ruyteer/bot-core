import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createProfile } from "../../test/helpers/seed.js";
import { complianceAlerts } from "../shared/schema/index.js";
import { scanText, normalize } from "./application/engine.js";
import { ComplianceRepository } from "./infrastructure/compliance.repository.js";

const repo = new ComplianceRepository();
const DICT = [{ keyword: "cocaína", category: "drogas" }, { keyword: "arma", category: "armas" }];

describe("engine.scanText", () => {
  it("casa palavra inteira, ignorando acento e caixa", () => {
    const m = scanText("Vendo COCAINA pura entrega hoje", DICT);
    expect(m.map((x) => x.keyword)).toContain("cocaina");
    expect(m[0].category).toBe("drogas");
  });

  it("NÃO casa substring (arma dentro de 'armadilha')", () => {
    expect(scanText("Comprei uma armadilha para ratos", DICT)).toHaveLength(0);
  });

  it("casa com pontuação colada", () => {
    expect(scanText("tem arma? sim", DICT).length).toBe(1);
  });

  it("sem dicionário → sem match", () => {
    expect(scanText("qualquer texto", [])).toHaveLength(0);
  });

  it("normalize remove acento/pontuação e minúscula", () => {
    expect(normalize("Ação, TESTE!")).toBe("acao teste");
  });
});

describe("repo.applyScan (idempotência + dismiss)", () => {
  async function match(kw: string) {
    return scanText(`texto com ${kw} aqui`, DICT);
  }

  it("cria alerta no 1º match e NÃO duplica no 2º (atualiza o mesmo)", async () => {
    const uid = await createProfile();
    const sid = crypto.randomUUID();
    await repo.applyScan("funnel", sid, uid, await match("cocaína"));
    await repo.applyScan("funnel", sid, uid, await match("cocaína"));
    const db = await testDb();
    const rows = await db.select().from(complianceAlerts).where(eq(complianceAlerts.sourceId, sid));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("pending");
  });

  it("sem match remove o alerta pendente", async () => {
    const uid = await createProfile();
    const sid = crypto.randomUUID();
    await repo.applyScan("bot", sid, uid, await match("arma"));
    await repo.applyScan("bot", sid, uid, []); // conteúdo limpo
    const db = await testDb();
    expect((await db.select().from(complianceAlerts).where(eq(complianceAlerts.sourceId, sid))).length).toBe(0);
  });

  it("dismiss trava a recriação da MESMA palavra", async () => {
    const uid = await createProfile();
    const sid = crypto.randomUUID();
    await repo.applyScan("offer", sid, uid, await match("cocaína"));
    const db = await testDb();
    const [a] = await db.select().from(complianceAlerts).where(eq(complianceAlerts.sourceId, sid));
    await repo.dismiss(a.id);
    // re-scan com a mesma palavra: não deve recriar pendente
    await repo.applyScan("offer", sid, uid, await match("cocaína"));
    const [after] = await db.select().from(complianceAlerts).where(eq(complianceAlerts.sourceId, sid));
    expect(after.status).toBe("dismissed");
  });

  it("palavra NOVA reabre mesmo após dismiss de outra", async () => {
    const uid = await createProfile();
    const sid = crypto.randomUUID();
    await repo.applyScan("offer", sid, uid, await match("cocaína"));
    const db = await testDb();
    const [a] = await db.select().from(complianceAlerts).where(eq(complianceAlerts.sourceId, sid));
    await repo.dismiss(a.id);
    // agora casa "arma" (palavra nova, não descartada) → volta a pending
    await repo.applyScan("offer", sid, uid, await match("arma"));
    const [after] = await db.select().from(complianceAlerts).where(eq(complianceAlerts.sourceId, sid));
    expect(after.status).toBe("pending");
    expect(after.keywords).toContain("arma");
  });

  it("pendingCount conta só os pending", async () => {
    const uid = await createProfile();
    await repo.applyScan("bot", crypto.randomUUID(), uid, await match("arma"));
    expect(await repo.pendingCount()).toBeGreaterThanOrEqual(1);
  });
});
