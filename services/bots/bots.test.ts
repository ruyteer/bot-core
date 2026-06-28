import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { CreateBotUseCase } from "./application/use-cases/create-bot.use-case.js";
import { RegisterWebhookUseCase } from "./application/use-cases/register-webhook.use-case.js";
import { BotDrizzleRepository } from "./infrastructure/bot.drizzle.repository.js";
import { testDb } from "../../test/helpers/db.js";
import { bots } from "../shared/schema/index.js";
import { createProfile, createBot } from "../../test/helpers/seed.js";
import { getTelegramCalls, forceTelegramError } from "../../test/helpers/fetch-mock.js";

const repo = new BotDrizzleRepository();

describe("CreateBotUseCase", () => {
  it("token válido (getMe ok) cria bot e sincroniza username", async () => {
    const userId = await createProfile();
    const bot = await new CreateBotUseCase(repo).execute({ userId, name: "Meu Bot", telegramToken: "111:ABC" });
    expect(bot.telegramUsername).toBe("testbot");
    const db = await testDb();
    const [row] = await db.select().from(bots).where(eq(bots.id, bot.id));
    expect(row.telegramToken).not.toBe("111:ABC"); // armazenado criptografado
  });

  it("token inválido (getMe falha) lança erro e não cria bot", async () => {
    const userId = await createProfile();
    forceTelegramError("getMe");
    await expect(new CreateBotUseCase(repo).execute({ userId, name: "X", telegramToken: "bad" })).rejects.toThrow();
    const db = await testDb();
    expect((await db.select().from(bots)).length).toBe(0);
  });
});

describe("RegisterWebhookUseCase", () => {
  it("setWebhook ok → ativa o bot e chama allowed_updates com my_chat_member", async () => {
    const bot = await createBot();
    const res = await new RegisterWebhookUseCase(repo).execute(bot.id, bot.userId);
    expect(res.ok).toBe(true);
    const call = getTelegramCalls("setWebhook")[0];
    expect((call.body.allowed_updates as string[])).toContain("my_chat_member");
    const db = await testDb();
    const [row] = await db.select().from(bots).where(eq(bots.id, bot.id));
    expect(row.isActive).toBe(true);
  });

  it("usuário sem permissão é barrado", async () => {
    const bot = await createBot();
    await expect(new RegisterWebhookUseCase(repo).execute(bot.id, crypto.randomUUID())).rejects.toThrow();
  });
});

describe("BotDrizzleRepository.findInternalById", () => {
  it("descriptografa o token do Telegram", async () => {
    const bot = await createBot({ token: "999:SECRET" });
    const internal = await repo.findInternalById(bot.id);
    expect(internal!.telegramToken).toBe("999:SECRET");
  });
});
