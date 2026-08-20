// Testa a whitelist server-side de `style` (sanitizeButtonStyle/sanitizeButtonArray/
// sanitizeAdvancedFilters) chamando os handlers REAIS de broadcasts.api.ts — não o
// use-case de processamento. process-broadcasts.test.ts seeda scheduledMessages
// direto via Drizzle e por isso nunca exercita esse controle de segurança; aqui a
// mensagem passa pelos endpoints create/update/send como o frontend faria.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { scheduledMessages } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { create, update, send } = await import("./broadcasts.api.js");

type Btn = { text?: string; style?: string };
type Advanced = { inline_buttons?: Btn[]; offers?: Btn[] };

describe("whitelist de style — endpoints reais de broadcasts", () => {
  it("create: style inválido em inline_buttons não é persistido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    const created = await create({
      botId: bot.id,
      message: "promo",
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      advancedFilters: { inline_buttons: [{ text: "Saiba mais", url: "https://x.com", style: "hackerman" }] },
    });

    const db = await testDb();
    const [row] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, created.id));
    const filters = row.advancedFilters as Advanced;
    expect(filters.inline_buttons?.[0].style).toBeUndefined();
  });

  it("create: style válido é preservado (sanidade — a whitelist não descarta tudo)", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    const created = await create({
      botId: bot.id,
      message: "promo",
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      advancedFilters: { inline_buttons: [{ text: "Saiba mais", url: "https://x.com", style: "constructive" }] },
    });

    const db = await testDb();
    const [row] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, created.id));
    const filters = row.advancedFilters as Advanced;
    expect(filters.inline_buttons?.[0].style).toBe("constructive");
  });

  it("update: style inválido em offers não é persistido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const created = await create({
      botId: bot.id,
      message: "promo",
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const updated = await update({
      id: created.id,
      advancedFilters: { offers: [{ product_id: "x", button_text: "Comprar", style: "hackerman" }] },
    });

    const db = await testDb();
    const [row] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, updated.id));
    const filters = row.advancedFilters as Advanced;
    expect(filters.offers?.[0].style).toBeUndefined();
  });

  it("send: style inválido em inlineButtons e offers não é persistido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    await send({
      botIds: [bot.id],
      broadcastType: "instant",
      filterType: "all",
      targetType: "leads",
      targetGroupIds: [],
      message: "promo",
      inlineButtons: [{ text: "Saiba mais", url: "https://x.com", style: "hackerman" }],
      offers: [{ product_id: "y", button_text: "Comprar", style: "hackerman" }],
    });

    const db = await testDb();
    const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.botId, bot.id));
    expect(rows).toHaveLength(1);
    const filters = rows[0].advancedFilters as Advanced;
    expect(filters.inline_buttons?.[0].style).toBeUndefined();
    expect(filters.offers?.[0].style).toBeUndefined();
  });
});
