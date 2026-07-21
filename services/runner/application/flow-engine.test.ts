import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { testDb } from "../../../test/helpers/db.js";
import { scheduledDelays, leadProgress, leadVariables, leads, leadEvents } from "../../shared/schema/index.js";
import { LeadDrizzleRepository } from "../../leads/infrastructure/lead.drizzle.repository.js";
import {
  createBot, createFlowFunnel, startUpdate, textUpdate, callbackUpdate,
} from "../../../test/helpers/seed.js";
import {
  getSentMessages, getTelegramCalls, resetFetchMock,
} from "../../../test/helpers/fetch-mock.js";

const useCase = new ExecuteFlowStepUseCase();
const leadRepo = new LeadDrizzleRepository();

async function leadIdByChat(botId: string, chatId: number): Promise<string> {
  const db = await testDb();
  const [l] = await db.select().from(leads).where(and(eq(leads.botId, botId), eq(leads.telegramChatId, BigInt(chatId))));
  return l.id;
}

// ── MESSAGE NODE ────────────────────────────────────────────────────────────
describe("message node", () => {
  it("escapa HTML do texto (< > &) para não quebrar parse_mode HTML", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { message: "1 < 2 & 3 > 0" } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(10) });
    expect(getSentMessages()[0]).toBe("1 &lt; 2 &amp; 3 &gt; 0");
  });

  it("blocos com simulate_typing disparam sendChatAction(typing)", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { blocks: [
          { type: "text", message: "oi", simulate_typing: true },
        ] } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(11) });
    const actions = getTelegramCalls("sendChatAction");
    expect(actions.some((a) => a.body.action === "typing")).toBe(true);
  });

  it("nó de Texto simples (sem blocks) com simulate_typing dispara typing antes da mensagem", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { message: "olá", simulate_typing: true } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(12) });
    expect(getTelegramCalls("sendChatAction").some((a) => a.body.action === "typing")).toBe(true);
    expect(getSentMessages().some((m) => m.includes("olá"))).toBe(true);
  });

  it("nó de áudio simula 'record_voice' por padrão", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "a", type: "audio", content: { url: "https://x/a.ogg" } },
      ],
      connections: [{ from: "t", to: "a" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(13) });
    expect(getTelegramCalls("sendChatAction").some((a) => a.body.action === "record_voice")).toBe(true);
  });
});

// ── BUTTONS NODE ────────────────────────────────────────────────────────────
describe("buttons node", () => {
  it("botão URL vira link (sem callback_data)", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "b", type: "buttons", content: { message: "links", buttons: [{ text: "Site", url: "https://x.com" }] } },
      ],
      connections: [{ from: "t", to: "b" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(12) });
    const call = getTelegramCalls("sendMessage").find((c) => c.body.reply_markup);
    const kb = (call!.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(kb[0][0]).toMatchObject({ text: "Site", url: "https://x.com" });
  });
});

// ── INPUT VALIDATION ────────────────────────────────────────────────────────
describe("input validation", () => {
  const cases: Array<{ kind: string; bad: string; good: string }> = [
    { kind: "email",  bad: "abc",          good: "a@b.com" },
    { kind: "number", bad: "abc",          good: "42" },
    { kind: "cpf",    bad: "111.111.111-11", good: "529.982.247-25" },
    { kind: "phone",  bad: "123",          good: "11987654321" },
  ];
  for (const c of cases) {
    it(`${c.kind}: rejeita inválido e aceita válido`, async () => {
      const bot = await createBot();
      await createFlowFunnel({
        userId: bot.userId, botId: bot.id,
        nodes: [
          { key: "t", type: "trigger" },
          { key: "ask", type: "input", content: { question: "?", variable_name: "v", validation: c.kind, error_message: "ERRO" } },
          { key: "ok", type: "message", content: { message: "OK" } },
        ],
        connections: [{ from: "t", to: "ask" }, { from: "ask", to: "ok" }],
      });
      const chat = 100 + Math.floor(Math.random() * 1e6);
      await useCase.execute({ botId: bot.id, update: startUpdate(chat) });
      await useCase.execute({ botId: bot.id, update: textUpdate(chat, c.bad) });
      expect(getSentMessages()).toContain("ERRO");
      expect(getSentMessages()).not.toContain("OK");
      await useCase.execute({ botId: bot.id, update: textUpdate(chat, c.good) });
      expect(getSentMessages()).toContain("OK");

      const db = await testDb();
      const [v] = await db.select().from(leadVariables).where(eq(leadVariables.variableName, "v"));
      expect(v.value).toBe(c.good);
    });
  }
});

// ── CONDITION NODE ──────────────────────────────────────────────────────────
describe("condition node", () => {
  async function runCond(operator: string, value: string, varValue: string): Promise<string[]> {
    resetFetchMock();
    const bot = await createBot();
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "set", type: "input", content: { question: "?", variable_name: "x" } },
        { key: "cond", type: "condition", content: { variable_name: "x", operator, value } },
        { key: "yes", type: "message", content: { message: "TRUE" } },
        { key: "no", type: "message", content: { message: "FALSE" } },
      ],
      connections: [
        { from: "t", to: "set" }, { from: "set", to: "cond" },
        { from: "cond", to: "yes", handle: "true" },
        { from: "cond", to: "no", handle: "false" },
      ],
    });
    void nodeIds;
    const chat = 200 + Math.floor(Math.random() * 1e6);
    await useCase.execute({ botId: bot.id, update: startUpdate(chat) });
    await useCase.execute({ botId: bot.id, update: textUpdate(chat, varValue) });
    return getSentMessages();
  }
  it("equals → true", async () => expect(await runCond("equals", "foo", "foo")).toContain("TRUE"));
  it("equals → false", async () => expect(await runCond("equals", "foo", "bar")).toContain("FALSE"));
  it("contains → true", async () => expect(await runCond("contains", "oo", "foobar")).toContain("TRUE"));
  it("not_empty → true", async () => expect(await runCond("not_empty", "", "algo")).toContain("TRUE"));
});

// ── RANDOM NODE (ponderado) ─────────────────────────────────────────────────
describe("random node", () => {
  async function runRandom(rand: number): Promise<string[]> {
    resetFetchMock();
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "r", type: "random", content: { outputs: [
          { name: "A", weight: 50, handle: "out_0" },
          { name: "B", weight: 50, handle: "out_1" },
        ] } },
        { key: "a", type: "message", content: { message: "RAMO-A" } },
        { key: "b", type: "message", content: { message: "RAMO-B" } },
      ],
      connections: [
        { from: "t", to: "r" },
        { from: "r", to: "a", handle: "out_0" },
        { from: "r", to: "b", handle: "out_1" },
      ],
    });
    const spy = vi.spyOn(Math, "random").mockReturnValue(rand);
    await useCase.execute({ botId: bot.id, update: startUpdate(300 + Math.floor(rand * 1000)) });
    spy.mockRestore();
    return getSentMessages();
  }
  it("random baixo → primeiro ramo (out_0)", async () => expect(await runRandom(0.1)).toContain("RAMO-A"));
  it("random alto → segundo ramo (out_1)", async () => expect(await runRandom(0.9)).toContain("RAMO-B"));
});

// ── DELAY NODE ──────────────────────────────────────────────────────────────
describe("delay node", () => {
  it("agenda scheduled_delay com o próximo nó e executeAt futuro", async () => {
    const bot = await createBot();
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "d", type: "delay", content: { seconds: 120 } },
        { key: "after", type: "message", content: { message: "DEPOIS" } },
      ],
      connections: [{ from: "t", to: "d" }, { from: "d", to: "after" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(40) });
    const db = await testDb();
    const rows = await db.select().from(scheduledDelays);
    expect(rows.length).toBe(1);
    expect(rows[0].nextNodeId).toBe(nodeIds.after);
    expect(rows[0].executeAt.getTime()).toBeGreaterThan(Date.now());
    expect(getSentMessages()).not.toContain("DEPOIS"); // ainda não enviou
  });

  it("delay zero continua imediatamente", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "d", type: "delay", content: { seconds: 0 } },
        { key: "after", type: "message", content: { message: "JA" } },
      ],
      connections: [{ from: "t", to: "d" }, { from: "d", to: "after" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(41) });
    expect(getSentMessages()).toContain("JA");
  });
});

// ── WAIT_RESPONSE NODE ──────────────────────────────────────────────────────
describe("wait_response node", () => {
  it("agenda timeout no handle no_response e responder cancela + segue 'responded'", async () => {
    const bot = await createBot();
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "w", type: "wait_response", content: { question: "responde?", timeout_seconds: 300 } },
        { key: "resp", type: "message", content: { message: "RESPONDEU" } },
        { key: "timeout", type: "message", content: { message: "TIMEOUT" } },
      ],
      connections: [
        { from: "t", to: "w" },
        { from: "w", to: "resp", handle: "responded" },
        { from: "w", to: "timeout", handle: "no_response" },
      ],
    });
    const chat = 50;
    await useCase.execute({ botId: bot.id, update: startUpdate(chat) });
    const db = await testDb();
    let delays = await db.select().from(scheduledDelays);
    expect(delays.length).toBe(1);
    expect(delays[0].nextNodeId).toBe(nodeIds.timeout);

    await useCase.execute({ botId: bot.id, update: textUpdate(chat, "oi") });
    expect(getSentMessages()).toContain("RESPONDEU");
    delays = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    expect(delays.length).toBe(0); // timeout cancelado
  });
});

// ── CONTROLE DE EXECUÇÃO ────────────────────────────────────────────────────
describe("controle de execução", () => {
  it("lead paused_manual não recebe automação", async () => {
    const bot = await createBot();
    const { funnelId } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { message: "OI" } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    const chat = 60;
    // cria lead + progress pausado
    await useCase.execute({ botId: bot.id, update: startUpdate(chat) });
    resetFetchMock();
    const db = await testDb();
    const leadId = await leadIdByChat(bot.id, chat);
    await db.update(leadProgress).set({ status: "paused_manual" }).where(eq(leadProgress.leadId, leadId));
    void funnelId;
    await useCase.execute({ botId: bot.id, update: textUpdate(chat, "ola") });
    expect(getSentMessages()).toHaveLength(0);
  });
});

// ── MEDIA NODE (álbum) ──────────────────────────────────────────────────────
describe("media node", () => {
  it("2+ imagens → envia como álbum (sendMediaGroup) numa só chamada", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "media", content: { media_type: "image", url: "https://a/1.jpg", caption: "legenda", extra_items: [{ media_type: "image", url: "https://a/2.jpg" }] } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(80) });
    const groups = getTelegramCalls("sendMediaGroup");
    expect(groups.length).toBe(1);
    expect((groups[0].body.media as unknown[]).length).toBe(2);
    expect(getTelegramCalls("sendPhoto").length).toBe(0);
  });

  it("1 imagem → envia como sendPhoto (sem álbum)", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "media", content: { media_type: "image", url: "https://a/1.jpg", caption: "x" } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(81) });
    expect(getTelegramCalls("sendMediaGroup").length).toBe(0);
    expect(getTelegramCalls("sendPhoto").length).toBe(1);
  });
});

// ── INTERPOLAÇÃO DE CAMPOS DE SISTEMA (bug #1) ──────────────────────────────
describe("interpolação de campos do lead", () => {
  it("{{first_name}} vira o nome do lead", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { message: "Oi {{first_name}}!" } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(900, { firstName: "Carlos" }) });
    expect(getSentMessages()).toContain("Oi Carlos!");
  });

  it("{{username}} vira o @username do lead", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { message: "user: {{username}}" } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(901, { firstName: "X", username: "buck123" }) });
    expect(getSentMessages()).toContain("user: buck123");
  });

  it("variável salva pelo usuário tem precedência sobre campo de sistema", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "ask", type: "input", content: { question: "?", variable_name: "first_name" } },
        { key: "m", type: "message", content: { message: "valor: {{first_name}}" } },
      ],
      connections: [{ from: "t", to: "ask" }, { from: "ask", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(902, { firstName: "Sistema" }) });
    await useCase.execute({ botId: bot.id, update: textUpdate(902, "DigitadoPeloUser") });
    expect(getSentMessages()).toContain("valor: DigitadoPeloUser");
  });
});

// ── MÉTRICAS DE TOPO DE FUNIL ───────────────────────────────────────────────
// `leads` tem uma linha por (bot, chat), então contar leads nunca mediu /start:
// "starts por lead" dava 1,00 sempre. Os eventos ficam em lead_events.
describe("lead_events (métrica de starts)", () => {
  it("cada /start do mesmo lead vira um evento; o lead continua único", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { message: "oi" } },
      ],
      connections: [{ from: "t", to: "m" }],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(4242) });
    await useCase.execute({ botId: bot.id, update: startUpdate(4242) });
    await useCase.execute({ botId: bot.id, update: startUpdate(4243) });

    const db = await testDb();
    const events = await db.select().from(leadEvents).where(eq(leadEvents.botId, bot.id));
    expect(events.length).toBe(3);
    expect(events.every((e) => e.kind === "start")).toBe(true);

    const stats = await leadRepo.getStats([bot.id]);
    expect(stats.starts).toBe(3);       // 3 comandos
    expect(stats.activeLeads).toBe(2);  // 2 pessoas
    expect(stats.starts / stats.activeLeads).toBeCloseTo(1.5); // antes: sempre 1,00
  });

  it("mensagem comum não conta como start", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [{ key: "t", type: "trigger" }, { key: "m", type: "message", content: { message: "oi" } }],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: textUpdate(4244, "bom dia") });
    const stats = await leadRepo.getStats([bot.id]);
    expect(stats.starts).toBe(0);
  });
});
