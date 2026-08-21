import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { CreateBotUseCase } from "./application/use-cases/create-bot.use-case.js";
import { RegisterWebhookUseCase } from "./application/use-cases/register-webhook.use-case.js";
import { DeregisterWebhookUseCase } from "./application/use-cases/deregister-webhook.use-case.js";
import { UpdateBotUseCase } from "./application/use-cases/update-bot.use-case.js";
import { BotDrizzleRepository } from "./infrastructure/bot.drizzle.repository.js";
import { testDb } from "../../test/helpers/db.js";
import { bots } from "../shared/schema/index.js";
import { createProfile, createBot } from "../../test/helpers/seed.js";
import { getTelegramCalls, forceTelegramError } from "../../test/helpers/fetch-mock.js";
import { setProfilePhoto, setChatPhoto, tgCallOrThrow } from "./application/telegram-profile.js";

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

  // O bug relatado: "sempre que cadastro um bot novo tenho que clicar em
  // reconectar". O registro do webhook era orquestrado pelo cliente, e a tela
  // "Meus Bots" não fazia essa chamada — o bot nascia sem webhook e, como
  // `is_active` tem default `true` no schema, aparecia ativo mesmo assim.
  it("criar o bot registra o webhook no Telegram, sem depender do cliente", async () => {
    const userId = await createProfile();
    const bot = await new CreateBotUseCase(repo).execute({ userId, name: "Bot", telegramToken: "111:ABC" });

    const call = getTelegramCalls("setWebhook")[0];
    expect(call).toBeDefined();
    expect(call.body.url).toBe(`https://test.orionbot.local/webhook/${bot.id}`);
    expect(call.body.allowed_updates as string[]).toContain("my_chat_member");

    const db = await testDb();
    const [row] = await db.select().from(bots).where(eq(bots.id, bot.id));
    expect(row.isActive).toBe(true);
    // O secret enviado ao Telegram tem que ser o gravado, senão o handler
    // rejeita todo update com 401.
    expect(call.body.secret_token).toBe(row.webhookSecret);
  });

  it("setWebhook falhando não desfaz o bot, mas ele NÃO fica ativo", async () => {
    // `is_active` deixa de ser um default otimista e passa a dizer a verdade:
    // sem isto o bot aparecia ativo e simplesmente não recebia nada.
    const userId = await createProfile();
    forceTelegramError("setWebhook");
    const bot = await new CreateBotUseCase(repo).execute({ userId, name: "Bot", telegramToken: "111:ABC" });

    const db = await testDb();
    const [row] = await db.select().from(bots).where(eq(bots.id, bot.id));
    expect(row.isActive).toBe(false);
    expect(row.telegramUsername).toBe("testbot"); // o bot existe e é utilizável
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

describe("DeregisterWebhookUseCase", () => {
  it("token revogado (401) → desativa localmente mesmo assim", async () => {
    const bot = await createBot();
    forceTelegramError("deleteWebhook", 401);
    const res = await new DeregisterWebhookUseCase(repo).execute(bot.id, bot.userId);
    expect(res.ok).toBe(true);
    const db = await testDb();
    const [row] = await db.select().from(bots).where(eq(bots.id, bot.id));
    expect(row.isActive).toBe(false);
  });

  it("erro real do Telegram (≠401/404) → lança com a descrição", async () => {
    const bot = await createBot();
    forceTelegramError("deleteWebhook", 500);
    await expect(new DeregisterWebhookUseCase(repo).execute(bot.id, bot.userId))
      .rejects.toThrow(/forced error/);
  });
});

describe("UpdateBotUseCase — troca de token", () => {
  it("token novo válido → re-criptografa e sincroniza username", async () => {
    const bot = await createBot({ token: "111:OLD" });
    await new UpdateBotUseCase(repo).execute(bot.id, bot.userId, { telegramToken: "222:NEW" });
    const internal = await repo.findInternalById(bot.id);
    expect(internal!.telegramToken).toBe("222:NEW"); // descriptografa pro novo
    const db = await testDb();
    const [row] = await db.select().from(bots).where(eq(bots.id, bot.id));
    expect(row.telegramToken).not.toBe("222:NEW");   // armazenado criptografado
    expect(row.telegramUsername).toBe("testbot");    // getMe sincronizou
  });

  it("token novo inválido (getMe falha) → rejeita sem alterar o token", async () => {
    const bot = await createBot({ token: "111:OLD" });
    forceTelegramError("getMe");
    await expect(new UpdateBotUseCase(repo).execute(bot.id, bot.userId, { telegramToken: "bad" }))
      .rejects.toThrow();
    const internal = await repo.findInternalById(bot.id);
    expect(internal!.telegramToken).toBe("111:OLD");
  });
});

describe("BotDrizzleRepository.findInternalById", () => {
  it("descriptografa o token do Telegram", async () => {
    const bot = await createBot({ token: "999:SECRET" });
    const internal = await repo.findInternalById(bot.id);
    expect(internal!.telegramToken).toBe("999:SECRET");
  });
});

// ── Perfil do bot no Telegram ────────────────────────────────────────────────
// setMyProfilePhoto/removeMyProfilePhoto existem desde a Bot API 9.4. O upload
// exige um InputProfilePhoto com attach:// — mandar o binário cru em `photo`
// (como era feito antes) o Telegram recusa.
describe("telegram-profile", () => {
  it("setProfilePhoto envia InputProfilePhoto static com attach:// e o arquivo à parte", async () => {
    await setProfilePhoto("111:ABC", Buffer.from("fake-jpeg").toString("base64"));
    const call = getTelegramCalls("setMyProfilePhoto")[0];
    expect(call).toBeDefined();
    expect(JSON.parse(call.body.photo as string)).toEqual({ type: "static", photo: "attach://pic" });
    expect(call.body.pic).toMatchObject({ file: "pic.jpg" });
  });

  it("setProfilePhoto propaga o erro do Telegram em vez de fingir sucesso", async () => {
    forceTelegramError("setMyProfilePhoto");
    await expect(setProfilePhoto("111:ABC", "eA==")).rejects.toThrow(/forced error/);
  });

  it("tgCallOrThrow transforma ok:false em erro (allSettled não via falha nenhuma)", async () => {
    forceTelegramError("setMyName");
    await expect(tgCallOrThrow("111:ABC", "setMyName", { name: "X" })).rejects.toThrow(/setMyName/);
    await expect(tgCallOrThrow("111:ABC", "setMyDescription", { description: "ok" })).resolves.toBeDefined();
  });

  it("setChatPhoto envia o binário direto no campo photo do multipart", async () => {
    await setChatPhoto("111:ABC", "-100123", Buffer.from("fake-jpeg").toString("base64"));
    const call = getTelegramCalls("setChatPhoto")[0];
    expect(call).toBeDefined();
    expect(call.body.chat_id).toBe("-100123");
    expect(call.body.photo).toMatchObject({ file: "photo.jpg" });
  });

  it("setChatPhoto propaga o erro do Telegram em vez de fingir sucesso", async () => {
    forceTelegramError("setChatPhoto");
    await expect(setChatPhoto("111:ABC", "-100123", "eA==")).rejects.toThrow(/setChatPhoto/);
  });
});
