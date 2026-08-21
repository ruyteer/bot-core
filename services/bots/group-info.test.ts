// Bug relatado: "ao alterar os dados de um canal ou grupo (principalmente
// nome) a UI continua retornando o dado/nome antigo no card. O dado novo só
// é mostrado no modal de edição." Causa raiz: updateGroupInfo (PATCH
// /bots/:id/groups/:chatId/info) só chamava a API do Telegram (setChatTitle)
// — nunca escrevia o nome novo em `bot_groups.name`, que é o que o card em
// /groups lê (o modal de edição, por outro lado, busca o título direto do
// Telegram via getGroupInfo, por isso "funcionava" só ali).
import { describe, it, expect, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { botGroups } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";
import { forceTelegramError } from "../../test/helpers/fetch-mock.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { updateGroupInfo } = await import("./bots.api.js");

async function seedGroup(botId: string, telegramChatId: bigint, name = "Nome Antigo") {
  const db = await testDb();
  const [row] = await db.insert(botGroups).values({
    botId, telegramChatId, name, type: "group",
  }).returning();
  return row;
}

describe("updateGroupInfo — sincroniza bot_groups.name além de chamar o Telegram", () => {
  it("troca de título persiste em bot_groups.name (não só no Telegram)", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const chatId = -1001234567890n;
    await seedGroup(bot.id, chatId, "Nome Antigo");

    await updateGroupInfo({ id: bot.id, chatId: chatId.toString(), title: "Nome Novo" });

    const db = await testDb();
    const [row] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, bot.id), eq(botGroups.telegramChatId, chatId)));
    expect(row.name).toBe("Nome Novo");
  });

  it("editar só a descrição não mexe em bot_groups.name", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const chatId = -1009876543210n;
    await seedGroup(bot.id, chatId, "Nome Original");

    await updateGroupInfo({ id: bot.id, chatId: chatId.toString(), description: "nova descrição" });

    const db = await testDb();
    const [row] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, bot.id), eq(botGroups.telegramChatId, chatId)));
    expect(row.name).toBe("Nome Original");
  });

  it("título muda com sucesso mesmo quando outro campo falha na mesma chamada — bot_groups.name reflete o título, e o erro do outro campo ainda é reportado", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const chatId = -1005555555555n;
    await seedGroup(bot.id, chatId, "Nome Antigo");
    forceTelegramError("setChatDescription");

    await expect(
      updateGroupInfo({ id: bot.id, chatId: chatId.toString(), title: "Nome Novo Parcial", description: "vai falhar" }),
    ).rejects.toThrow();

    const db = await testDb();
    const [row] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, bot.id), eq(botGroups.telegramChatId, chatId)));
    expect(row.name).toBe("Nome Novo Parcial");
  });
});
