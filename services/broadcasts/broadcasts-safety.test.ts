// Regressão dos riscos confirmados em nova-ui/docs/fase-5/semantica-e-riscos.md
// (broadcasts): clique duplo criando dois disparos. Chama os handlers REAIS
// de broadcasts.api.ts.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { scheduledMessages } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { create, send } = await import("./broadcasts.api.js");

describe("clientRequestId — clique duplo não cria dois disparos", () => {
  it("create: mesma clientRequestId devolve o disparo já criado, sem duplicar", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const payload = {
      botId: bot.id, message: "promo",
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      clientRequestId: "click-abc-123",
    };

    const first = await create(payload);
    const second = await create(payload);
    expect(second.id).toBe(first.id);

    const db = await testDb();
    const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.botId, bot.id));
    expect(rows).toHaveLength(1);
  });

  it("create: clientRequestId diferente cria disparos distintos (sanidade)", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const base = { botId: bot.id, message: "promo", scheduledAt: new Date(Date.now() + 60_000).toISOString() };

    const a = await create({ ...base, clientRequestId: "a" });
    const b = await create({ ...base, clientRequestId: "b" });
    expect(a.id).not.toBe(b.id);
  });

  it("send: mesma clientRequestId não cria um segundo disparo", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const payload = {
      botIds: [bot.id], broadcastType: "instant", filterType: "all", targetType: "leads",
      targetGroupIds: [], message: "promo", clientRequestId: "dbl-tap-1",
    };

    await send(payload);
    await send(payload);

    const db = await testDb();
    const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.botId, bot.id));
    expect(rows).toHaveLength(1);
  });
});
