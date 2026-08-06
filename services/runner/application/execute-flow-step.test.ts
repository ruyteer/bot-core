import { describe, it, expect } from "vitest";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import {
  createBot, createFlowFunnel, startUpdate, textUpdate, callbackUpdate, getProgress,
} from "../../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls } from "../../../test/helpers/fetch-mock.js";

const useCase = new ExecuteFlowStepUseCase();

describe("ExecuteFlowStepUseCase — smoke", () => {
  it("/start entra no funil e envia a primeira mensagem", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(1001) });

    expect(getSentMessages()).toContain("Bem-vindo!");
  });

  it("nó de botões envia inline keyboard e o callback avança", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "btn", type: "buttons", content: { message: "Escolha:", buttons: [{ text: "A", callback: "opt_a" }] } },
        { key: "done", type: "message", content: { message: "Você escolheu A" } },
      ],
      connections: [
        { from: "trigger", to: "btn" },
        { from: "btn", to: "done", handle: "opt_a" },
      ],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(1002) });
    const withKeyboard = getTelegramCalls("sendMessage").find((c) => c.body.reply_markup);
    expect(withKeyboard).toBeDefined();

    await useCase.execute({ botId: bot.id, update: callbackUpdate(1002, "opt_a") });
    expect(getSentMessages()).toContain("Você escolheu A");
  });

  it("validação de e-mail: inválido fica no nó, válido avança e salva variável", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "ask", type: "input", content: { question: "Seu e-mail?", variable_name: "email", validation: "email", error_message: "E-mail inválido" } },
        { key: "thanks", type: "message", content: { message: "Obrigado, {{email}}" } },
      ],
      connections: [
        { from: "trigger", to: "ask" },
        { from: "ask", to: "thanks" },
      ],
    });

    const lead = 1003;
    await useCase.execute({ botId: bot.id, update: startUpdate(lead) });
    await useCase.execute({ botId: bot.id, update: textUpdate(lead, "naoehemail") });
    expect(getSentMessages()).toContain("E-mail inválido");

    await useCase.execute({ botId: bot.id, update: textUpdate(lead, "user@test.com") });
    expect(getSentMessages().some((m) => m.includes("user@test.com"))).toBe(true);
  });
});
