// PUT /admin/config/:key aceitava qualquer chave (inclusive coisas que a UI
// nunca edita). A allowlist cobre só o que as duas UIs gravam de fato.
import { describe, it, expect, vi } from "vitest";
import { testDb } from "../../test/helpers/db.js";
import { createBot, createProfile } from "../../test/helpers/seed.js";
import { platformConfig, userRoles } from "../shared/schema/index.js";
import { eq } from "drizzle-orm";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { setConfig, getConfig } = await import("./admin.api.js");

async function asAdmin(): Promise<string> {
  const db = await testDb();
  const id = await createProfile();
  await db.insert(userRoles).values({ userId: id, role: "admin" });
  authUserId = id;
  return id;
}

describe("PUT /admin/config/:key — allowlist", () => {
  it("grava chave que a UI antiga e a nova editam (WhatsApp, split)", async () => {
    await asAdmin();
    await expect(setConfig({ key: "WHATSAPP_SUPPORT_PHONE", value: "5511999999999" }))
      .resolves.toEqual({ ok: true });
    await expect(setConfig({ key: "BUCKPAY_SPLIT_ENABLED", value: "true" }))
      .resolves.toEqual({ ok: true });
    await expect(setConfig({ key: "TELEGRAM_SECRET_TOKEN", value: "tok_legado" }))
      .resolves.toEqual({ ok: true });

    const db = await testDb();
    const rows = await db.select().from(platformConfig);
    expect(rows.map((r) => r.key).sort()).toEqual([
      "BUCKPAY_SPLIT_ENABLED",
      "TELEGRAM_SECRET_TOKEN",
      "WHATSAPP_SUPPORT_PHONE",
    ]);
  });

  it("recusa chave fora da lista e não grava", async () => {
    await asAdmin();
    await expect(setConfig({ key: "ENCRYPTION_KEY", value: "x" }))
      .rejects.toThrow(/não permitida/);
    await expect(setConfig({ key: "USER_SPLIT_FEE_CENTS_alguem", value: "40" }))
      .rejects.toThrow(/não permitida/);

    const db = await testDb();
    const rows = await db.select().from(platformConfig);
    expect(rows).toHaveLength(0);
  });

  it("não-admin não grava nem chave permitida", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    await expect(setConfig({ key: "WHATSAPP_SUPPORT_PHONE", value: "1" }))
      .rejects.toThrow(/admin/i);
  });

  it("GET continua lendo qualquer chave (UI antiga lê TELEGRAM_SECRET_TOKEN)", async () => {
    const db = await testDb();
    await asAdmin();
    await db.insert(platformConfig).values({ key: "ENCRYPTION_KEY", value: "secreto" });
    await expect(getConfig({ key: "ENCRYPTION_KEY" })).resolves.toEqual({ value: "secreto" });
    await expect(getConfig({ key: "AUSENTE" })).resolves.toEqual({ value: null });
  });
});
