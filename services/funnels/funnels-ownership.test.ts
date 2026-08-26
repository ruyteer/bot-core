// Testes de regressão do IDOR crítico: endpoints que gravam bot em funil
// (update/duplicate/assignBots/create/createOffer/createOffersBulk) precisam
// checar que o botId pertence ao usuário autenticado ANTES de escrever —
// senão qualquer conta consegue "sequestrar" o funil (e o PIX) de um bot
// alheio, já que o botId da vítima é público (aparece em `GET /r?b=<botId>`).
// Chama os handlers REAIS de funnels.api.ts, não o repositório direto.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import { testDb } from "../../test/helpers/db.js";
import { funnels, funnelBots } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { create, update, duplicate, assignBots, createOffer, createOffersBulk } =
  await import("./funnels.api.js");
const { assertBotOwnership, assertBotsOwnership } = await import("../shared/bot-ownership.js");

describe("posse de bot — endpoints reais de funnels", () => {
  it("create: rejeita botId de outro usuário", async () => {
    const owner = await createBot();
    const attacker = await createBot();
    authUserId = attacker.userId;

    await expect(create({ name: "F", botId: owner.id })).rejects.toThrow();
  });

  it("create: aceita bot próprio (caso feliz)", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    const created = await create({ name: "F", botId: bot.id });
    expect(created.botId).toBe(bot.id);
  });

  it("update: rejeita botId de outro usuário sem deixar escrita parcial", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });

    const attackerBot = await createBot();

    await expect(update({ id: funnel.id, botId: attackerBot.id })).rejects.toThrow();

    const db = await testDb();
    const [row] = await db.select().from(funnels).where(eq(funnels.id, funnel.id));
    expect(row.botId).toBe(owner.id); // não foi reatribuído
  });

  it("update: aceita botId próprio (caso feliz, inclui trocar entre dois bots do mesmo usuário)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });
    const secondBot = await createBot({ userId: owner.userId });

    const updated = await update({ id: funnel.id, botId: secondBot.id });
    expect(updated.botId).toBe(secondBot.id);
  });

  it("update: botId null (desvincular) continua permitido", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });

    const updated = await update({ id: funnel.id, botId: null });
    expect(updated.botId).toBeNull();
  });

  it("duplicate: rejeita targetBotId de outro usuário sem criar cópia", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });

    const attackerBot = await createBot();

    await expect(duplicate({ id: funnel.id, targetBotId: attackerBot.id })).rejects.toThrow();

    const db = await testDb();
    const rows = await db.select().from(funnels).where(eq(funnels.userId, owner.userId));
    expect(rows.length).toBe(1); // só o original, nenhuma cópia foi criada
  });

  it("duplicate: aceita targetBotId próprio (caso feliz)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });
    const secondBot = await createBot({ userId: owner.userId });

    const dup = await duplicate({ id: funnel.id, targetBotId: secondBot.id });
    expect(dup.botId).toBe(secondBot.id);
  });

  it("assignBots: rejeita array com um id alheio misturado, sem gravar nenhum vínculo", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });
    const secondBot = await createBot({ userId: owner.userId });
    const attackerBot = await createBot();

    await expect(
      assignBots({ id: funnel.id, botIds: [secondBot.id, attackerBot.id] }),
    ).rejects.toThrow();

    const db = await testDb();
    const links = await db.select().from(funnelBots).where(eq(funnelBots.funnelId, funnel.id));
    // create() já vincula o bot original; o assignBots rejeitado não deve ter mexido em nada
    expect(links.map((l) => l.botId)).toEqual([owner.id]);
  });

  it("assignBots: aceita lista de bots próprios (caso feliz)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });
    const secondBot = await createBot({ userId: owner.userId });

    await assignBots({ id: funnel.id, botIds: [owner.id, secondBot.id] });

    const db = await testDb();
    const links = await db.select().from(funnelBots).where(eq(funnelBots.funnelId, funnel.id));
    expect(new Set(links.map((l) => l.botId))).toEqual(new Set([owner.id, secondBot.id]));
  });

  it("assignBots: array vazio é no-op válido (desvincula todos, não erro)", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });

    await expect(assignBots({ id: funnel.id, botIds: [] })).resolves.toEqual({ ok: true });

    const db = await testDb();
    const links = await db.select().from(funnelBots).where(eq(funnelBots.funnelId, funnel.id));
    expect(links.length).toBe(0);
  });

  it("createOffer: rejeita botId de outro usuário", async () => {
    const owner = await createBot();
    const attacker = await createBot();
    authUserId = attacker.userId;

    await expect(createOffer({ botId: owner.id, name: "Oferta", price: 1000 })).rejects.toThrow();
  });

  it("createOffersBulk: rejeita se qualquer botId do lote for de outro usuário", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const attackerBot = await createBot();

    await expect(
      createOffersBulk({
        offers: [
          { botId: owner.id, name: "Oferta 1", price: 1000 },
          { botId: attackerBot.id, name: "Oferta 2", price: 2000 },
        ],
      }),
    ).rejects.toThrow();
  });

  // Regressão: botId malformado (não-uuid) não pode estourar o driver Postgres
  // cru ("invalid input syntax for type uuid") — tem que virar APIError.notFound
  // limpo, igual a um bot inexistente. Achado do reviewer no fix do IDOR.
  it("createOffersBulk: botId malformado (não-uuid) vira APIError.notFound, não erro cru do driver", async () => {
    const owner = await createBot();
    authUserId = owner.userId;

    let caught: unknown;
    try {
      await createOffersBulk({
        offers: [{ botId: "nao-e-um-uuid", name: "Oferta", price: 1000 }],
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).code).toBe("not_found");
  });

  it("assertBotOwnership: id malformado (não-uuid) vira APIError.notFound sem consultar o banco", async () => {
    let caught: unknown;
    try {
      await assertBotOwnership("nao-e-um-uuid", crypto.randomUUID());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).code).toBe("not_found");
  });

  it("assertBotsOwnership: qualquer id malformado no array vira APIError.notFound", async () => {
    const owner = await createBot();
    let caught: unknown;
    try {
      await assertBotsOwnership([owner.id, "nao-e-um-uuid"], owner.userId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).code).toBe("not_found");
  });
});
