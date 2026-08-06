import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { testDb } from "../../../test/helpers/db.js";
import { botGroups, leads } from "../../shared/schema/index.js";
import { createBot, myChatMemberUpdate } from "../../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls } from "../../../test/helpers/fetch-mock.js";

const useCase = new ExecuteFlowStepUseCase();

describe("eventos de grupo/canal", () => {
  it("bot vira admin → salva grupo e envia o ID no chat", async () => {
    const bot = await createBot();
    await useCase.execute({ botId: bot.id, update: myChatMemberUpdate(-100500, "administrator", "supergroup") });
    const db = await testDb();
    const groups = await db.select().from(botGroups);
    expect(groups.length).toBe(1);
    expect(groups[0].telegramChatId).toBe(BigInt(-100500));
    expect(getSentMessages().some((m) => m.includes("-100500"))).toBe(true);
  });

  it("bot removido (kicked) → apaga grupo", async () => {
    const bot = await createBot();
    await useCase.execute({ botId: bot.id, update: myChatMemberUpdate(-100600, "administrator") });
    let db = await testDb();
    expect((await db.select().from(botGroups)).length).toBe(1);
    await useCase.execute({ botId: bot.id, update: myChatMemberUpdate(-100600, "kicked") });
    db = await testDb();
    expect((await db.select().from(botGroups)).length).toBe(0);
  });

  it("mensagem /id em grupo salva e responde o ID; não vira lead", async () => {
    const bot = await createBot();
    const update = {
      update_id: 1,
      message: { message_id: 1, chat: { id: -100700, type: "supergroup" }, from: { id: 9, first_name: "U" }, text: "/id", date: 0 },
    };
    await useCase.execute({ botId: bot.id, update });
    const db = await testDb();
    expect((await db.select().from(botGroups)).length).toBe(1);
    expect((await db.select().from(leads)).length).toBe(0); // grupo não é lead
    expect(getSentMessages().some((m) => m.includes("-100700"))).toBe(true);
  });

  it("bot adicionado como MEMBRO comum → não salva grupo nem envia mensagem", async () => {
    const bot = await createBot();
    await useCase.execute({ botId: bot.id, update: myChatMemberUpdate(-100900, "member", "group") });
    const db = await testDb();
    expect((await db.select().from(botGroups)).length).toBe(0);
    expect(getSentMessages()).toHaveLength(0);
  });

  it("migração grupo→supergrupo remapeia o registro para o id novo (sem duplicar)", async () => {
    const bot = await createBot();
    await useCase.execute({ botId: bot.id, update: myChatMemberUpdate(-500, "administrator", "group") });
    let db = await testDb();
    expect((await db.select().from(botGroups)).length).toBe(1);

    // Mensagem de serviço no chat antigo anunciando o id novo
    await useCase.execute({ botId: bot.id, update: {
      update_id: 2,
      message: { message_id: 2, chat: { id: -500, type: "group" }, from: { id: 9, first_name: "U" }, date: 0, migrate_to_chat_id: -1000500 },
    } });
    db = await testDb();
    const groups = await db.select().from(botGroups);
    expect(groups.length).toBe(1);
    expect(groups[0].telegramChatId).toBe(BigInt(-1000500));
    expect(groups[0].type).toBe("supergroup");
  });

  it("migração quando o supergrupo JÁ foi salvo → funde em uma linha só", async () => {
    const bot = await createBot();
    await useCase.execute({ botId: bot.id, update: myChatMemberUpdate(-600, "administrator", "group") });
    await useCase.execute({ botId: bot.id, update: myChatMemberUpdate(-1000600, "administrator", "supergroup") });
    let db = await testDb();
    expect((await db.select().from(botGroups)).length).toBe(2);

    await useCase.execute({ botId: bot.id, update: {
      update_id: 3,
      message: { message_id: 3, chat: { id: -1000600, type: "supergroup" }, from: { id: 9, first_name: "U" }, date: 0, migrate_from_chat_id: -600 },
    } });
    db = await testDb();
    const groups = await db.select().from(botGroups);
    expect(groups.length).toBe(1);
    expect(groups[0].telegramChatId).toBe(BigInt(-1000600));
  });

  it("mensagem comum em grupo é ignorada (não cria lead)", async () => {
    const bot = await createBot();
    const update = {
      update_id: 1,
      message: { message_id: 1, chat: { id: -100800, type: "group" }, from: { id: 9, first_name: "U" }, text: "oi", date: 0 },
    };
    await useCase.execute({ botId: bot.id, update });
    const db = await testDb();
    expect((await db.select().from(leads)).length).toBe(0);
    expect(getSentMessages()).toHaveLength(0);
  });
});
