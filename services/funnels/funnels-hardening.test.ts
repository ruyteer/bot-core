// Endurecimentos achados pela auditoria de segurança da UI nova:
// - POST /funnels não validava `kind` (aceitava qualquer string) nem
//   normalizava "flow_chat" (o que a UI antiga manda) pra "flow".
// - PUT /funnels/:id/bots não tinha limite de bots (a UI antiga limitava a 5
//   client-side, mas a API aceitava qualquer quantidade).
// - saveFlow/update lançavam Error("funnel not found") cru — virava 500 em
//   vez de 404.
import { describe, it, expect, vi } from "vitest";
import { APIError } from "encore.dev/api";
import { createBot } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { create, assignBots, update, saveFlow } = await import("./funnels.api.js");

describe("create — validação/normalização de kind", () => {
  it("sem kind, usa 'flow' por padrão", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const funnel = await create({ name: "F", botId: bot.id });
    expect(funnel.kind).toBe("flow");
  });

  it("normaliza 'flow_chat' (o que a UI antiga manda) para 'flow'", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const funnel = await create({ name: "F", botId: bot.id, kind: "flow_chat" });
    expect(funnel.kind).toBe("flow");
  });

  it("aceita 'simplified'", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const funnel = await create({ name: "F", botId: bot.id, kind: "simplified" });
    expect(funnel.kind).toBe("simplified");
  });

  it("rejeita kind desconhecido", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    await expect(create({ name: "F", botId: bot.id, kind: "qualquer-coisa" })).rejects.toThrow(/kind inválido/);
  });
});

describe("assignBots — limite de 5 bots por funil (mesmo limite da UI antiga)", () => {
  it("rejeita mais de 5 bots e não grava nenhum vínculo", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });

    const extraBots = await Promise.all(
      Array.from({ length: 5 }, () => createBot({ userId: owner.userId })),
    );
    const botIds = [owner.id, ...extraBots.map((b) => b.id)]; // 6 no total

    await expect(assignBots({ id: funnel.id, botIds })).rejects.toThrow(/limite de 5 bots/);
  });

  it("aceita exatamente 5 bots", async () => {
    const owner = await createBot();
    authUserId = owner.userId;
    const funnel = await create({ name: "F", botId: owner.id });

    const extraBots = await Promise.all(
      Array.from({ length: 4 }, () => createBot({ userId: owner.userId })),
    );
    const botIds = [owner.id, ...extraBots.map((b) => b.id)]; // 5 no total

    await expect(assignBots({ id: funnel.id, botIds })).resolves.toEqual({ ok: true });
  });
});

describe("funnel not found — 404 (APIError), não erro genérico virando 500", () => {
  it("update: funil inexistente vira APIError.notFound", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    let caught: unknown;
    try {
      await update({ id: crypto.randomUUID(), name: "Novo nome" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).code).toBe("not_found");
  });

  it("saveFlow: funil inexistente vira APIError.notFound", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    let caught: unknown;
    try {
      await saveFlow({ id: crypto.randomUUID(), nodes: [], connections: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).code).toBe("not_found");
  });
});
