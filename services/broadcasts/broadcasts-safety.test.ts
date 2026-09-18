// Regressão dos riscos confirmados em nova-ui/docs/fase-5/semantica-e-riscos.md
// (broadcasts): clique duplo criando dois disparos, edição/cancelamento
// durante o envio, e POST /broadcasts/send pulando a varredura de conteúdo
// que create()/update() já fazem. Chama os handlers REAIS de broadcasts.api.ts.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import { testDb } from "../../test/helpers/db.js";
import { scheduledMessages } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const scanSourceAsyncMock = vi.fn();
vi.mock("../compliance/application/scan.js", () => ({
  scanSourceAsync: (...args: unknown[]) => scanSourceAsyncMock(...args),
}));

const { create, send, update, remove } = await import("./broadcasts.api.js");

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

describe("PATCH/DELETE durante envio — 409 em vez de mentir com 200", () => {
  async function createSendingBroadcast() {
    const bot = await createBot();
    const db = await testDb();
    const [row] = await db.insert(scheduledMessages).values({
      userId: bot.userId, botId: bot.id, botIds: [bot.id], message: "promo",
      broadcastType: "instant", filterType: "all", targetType: "leads", targetGroupIds: [],
      scheduledAt: new Date(), status: "sending",
    }).returning();
    return { bot, row };
  }

  it("update: 409 (aborted) quando o disparo está em 'sending'", async () => {
    const { bot, row } = await createSendingBroadcast();
    authUserId = bot.userId;

    let error: unknown;
    try { await update({ id: row.id, message: "editado" }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).code).toBe("aborted");

    const db = await testDb();
    const [after] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id));
    expect(after.message).toBe("promo"); // não alterou nada
  });

  it("remove: 409 (aborted) quando o disparo está em 'sending'", async () => {
    const { bot, row } = await createSendingBroadcast();
    authUserId = bot.userId;

    let error: unknown;
    try { await remove({ id: row.id }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).code).toBe("aborted");

    const db = await testDb();
    const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id));
    expect(rows).toHaveLength(1); // não excluiu
  });

  it("update: fora de 'sending' continua funcionando normalmente (sanidade)", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const created = await create({ botId: bot.id, message: "promo", scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    const updated = await update({ id: created.id, message: "editado" });
    expect(updated.message).toBe("editado");
  });
});

describe("send() chama a varredura de conteúdo (scanSourceAsync), igual create()", () => {
  it("send: chama scanSourceAsync('broadcast', id) após enfileirar", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    scanSourceAsyncMock.mockClear();

    await send({
      botIds: [bot.id], broadcastType: "instant", filterType: "all", targetType: "leads",
      targetGroupIds: [], message: "promo",
    });

    expect(scanSourceAsyncMock).toHaveBeenCalledWith("broadcast", expect.any(String));
  });
});
