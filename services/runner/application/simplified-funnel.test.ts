import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { ExecuteSimplifiedFunnelUseCase } from "./execute-simplified-funnel.use-case.js";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { TelegramClient } from "./telegram.client.js";
import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { testDb } from "../../../test/helpers/db.js";
import { bots, leads, funnels, payments, simplifiedScheduledTasks, leadProgress } from "../../shared/schema/index.js";
import { createBot, createGateway, createSimplifiedFunnel, createLead, startUpdate, callbackUpdate } from "../../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls, rejectUnescapedTelegramHtml } from "../../../test/helpers/fetch-mock.js";

const simplified = new ExecuteSimplifiedFunnelUseCase();
const flow = new ExecuteFlowStepUseCase();
const payRepo = new PaymentDrizzleRepository();

const tg = new TelegramClient("test");

async function rows(botId: string, funnelId: string, chatId: bigint) {
  const db = await testDb();
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  const [funnel] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
  const [lead] = await db.select().from(leads).where(eq(leads.telegramChatId, chatId));
  return { bot, funnel, lead };
}

function lastKeyboard() {
  const call = [...getTelegramCalls()].reverse().find((c) => c.body.reply_markup);
  return (call?.body.reply_markup as { inline_keyboard: { callback_data?: string; text?: string }[][] })?.inline_keyboard ?? [];
}

async function baseFunnel(extra: Record<string, unknown> = {}) {
  const bot = await createBot();
  const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
  const config = {
    payment: { gateway_id: gwId },
    plans: [{ id: "p1", name: "Plano Pro", price: 19.9 }],
    ...extra,
  };
  const funnelId = await createSimplifiedFunnel({ userId: bot.userId, botId: bot.id, config });
  const chatId = BigInt(800 + Math.floor(Math.random() * 1e6));
  const leadId = await createLead(bot.id, chatId);
  return { bot, gwId, funnelId, chatId, leadId };
}

describe("simplified — welcome e CTA", () => {
  it("/start sem CTA envia welcome + botões de plano (sp_)", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({ welcome: { text: "Bem-vindo!" } });
    const r = await rows(bot.id, funnelId, chatId);
    const handled = await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: "/start", callbackData: null, callbackMessageId: null, tg });
    expect(handled).toBe(true);
    const kb = lastKeyboard();
    expect(kb[0][0].callback_data).toBe("sp_p1");
  });

  it("/start com CTA envia accept/decline; accept abre planos", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({ cta: { enabled: true, text: "Quer ver?" } });
    const r = await rows(bot.id, funnelId, chatId);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: "/start", callbackData: null, callbackMessageId: null, tg });
    let kb = lastKeyboard();
    expect(kb[0][0].callback_data).toBe(`sc_accept_${funnelId}`);
    expect(kb[0][1].callback_data).toBe(`sc_decline_${funnelId}`);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: `sc_accept_${funnelId}`, callbackMessageId: 5, tg });
    kb = lastKeyboard();
    expect(kb.some((row) => row[0].callback_data === "sp_p1")).toBe(true);
  });

  it("/start com CTA e decline_enabled=false envia só o botão de aceitar", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({ cta: { enabled: true, text: "Quer ver?", decline_enabled: false } });
    const r = await rows(bot.id, funnelId, chatId);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: "/start", callbackData: null, callbackMessageId: null, tg });
    const kb = lastKeyboard();
    expect(kb[0].length).toBe(1);
    expect(kb[0][0].callback_data).toBe(`sc_accept_${funnelId}`);
  });

  it("callback sc_decline antigo (keyboard em cache) ainda é tratado mesmo com decline_enabled=false", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({ cta: { enabled: true, text: "Quer ver?", decline_enabled: false, decline_message: "Sem problema!" } });
    const r = await rows(bot.id, funnelId, chatId);
    const handled = await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: `sc_decline_${funnelId}`, callbackMessageId: 5, tg });
    expect(handled).toBe(true);
    expect(getSentMessages().some((m) => m.includes("Sem problema!"))).toBe(true);
  });
});

describe("simplified — planos, bumps e PIX", () => {
  it("clique no plano sem bumps gera PIX em centavos com ctx plan", async () => {
    const { bot, funnelId, chatId } = await baseFunnel();
    const r = await rows(bot.id, funnelId, chatId);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 9, tg });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay.amount).toBe(1990);
    expect((pay.simplifiedCtx as { kind: string }).kind).toBe("plan");
    expect(pay.splitSnapshot).toEqual({ receiver: null, cents: 0, feeCents: 0 }); // snapshot do split do PIX
    expect(getTelegramCalls("sendPhoto").length).toBeGreaterThan(0); // QR
  });

  it("plano com order bump aplicável envia card de bump; sb_yes soma ao PIX", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({
      order_bumps: [{ id: "b1", name: "Bônus", price: 10, attached_plan_ids: ["p1"] }],
    });
    const r = await rows(bot.id, funnelId, chatId);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 9, tg });
    const kb = lastKeyboard();
    expect(kb.some((row) => String(row[0].callback_data).startsWith("sb_yes_"))).toBe(true);

    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sb_yes_p1", callbackMessageId: 10, tg });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay.amount).toBe(2990); // 19.90 + 10.00
  });

  it("dedup: clicar 2x no mesmo plano em 1h reaproveita o PIX (1 payment)", async () => {
    const { bot, funnelId, chatId } = await baseFunnel();
    const r = await rows(bot.id, funnelId, chatId);
    const args = { bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 9, tg };
    await simplified.handle(args);
    await simplified.handle(args);
    const db = await testDb();
    expect((await db.select().from(payments)).length).toBe(1);
  });
});

describe("simplified — entrega e agendamentos", () => {
  it("deliverPaid entrega itens e agenda upsell do plano", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({
      plans: [{ id: "p1", name: "Plano Pro", price: 19.9, delivery_type: "content", delivery_url: "https://area-membros" }],
      upsells: [{ id: "u1", name: "Upgrade", price: 30, delay_minutes: 0 }],
    });
    const r = await rows(bot.id, funnelId, chatId);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 9, tg });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    await simplified.deliverPaid((await payRepo.findById(pay.id))!);
    expect(getSentMessages().some((m) => m.includes("area-membros"))).toBe(true);
    const tasks = await db.select().from(simplifiedScheduledTasks).where(eq(simplifiedScheduledTasks.kind, "upsell"));
    expect(tasks.length).toBe(1);
  });

  it("processDueTasks dispara upsell vencido com botão su_", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({
      upsells: [{ id: "u1", name: "Upgrade", price: 30, delay_minutes: 0 }],
    });
    const r = await rows(bot.id, funnelId, chatId);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 9, tg });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    await simplified.deliverPaid((await payRepo.findById(pay.id))!);
    const n = await simplified.processDueTasks();
    expect(n).toBeGreaterThanOrEqual(1);
    const kb = lastKeyboard();
    expect(kb[0][0].callback_data).toBe("su_u1");
  });
});

describe("simplified — roteamento via execute-flow-step", () => {
  it("funil simplificado ativo (kind=simplified) é roteado no /start", async () => {
    const { bot, chatId } = await baseFunnel({ welcome: { text: "Olá simplificado" } });
    await flow.execute({ botId: bot.id, update: { ...startUpdate(Number(chatId)) } });
    expect(getSentMessages().some((m) => m.includes("Olá simplificado"))).toBe(true);
  });
});

describe("simplified — interpolação de {{first_name}} (bug #1)", () => {
  it("welcome interpola o nome do lead", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({ welcome: { text: "Olá {{first_name}}!" } });
    const r = await rows(bot.id, funnelId, chatId); // lead.firstName = "Lead"
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: "/start", callbackData: null, callbackMessageId: null, tg });
    expect(getSentMessages().some((m) => m.includes("Olá Lead!"))).toBe(true);
  });
});

// ── Auditoria 24/09 — achados do runner do funil simplificado ──────────────────

describe("simplified — claim atômico do tick de tarefas (Achado 1)", () => {
  it("uma 2ª chamada de processDueTasks não reprocessa a mesma tarefa (claim marca 'processing'/'done')", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({
      upsells: [{ id: "u1", name: "Upgrade", price: 30, delay_minutes: 0 }],
    });
    const r = await rows(bot.id, funnelId, chatId);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 9, tg });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    await simplified.deliverPaid((await payRepo.findById(pay.id))!);

    // Simula dois ticks (réplicas) disputando a mesma tarefa vencida: sem o
    // claim atômico, as duas processavam e mandavam o upsell em dobro.
    const [n1, n2] = [await simplified.processDueTasks(), await simplified.processDueTasks()];
    expect(n1).toBe(1);
    expect(n2).toBe(0); // já foi "done" pelo primeiro claim — nada sobrou pending
    const upsellMsgs = getTelegramCalls("sendMessage").filter((c) => {
      const kb = (c.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
      return kb?.flat().some((b) => b.callback_data === "su_u1");
    });
    expect(upsellMsgs.length).toBe(1);
  });
});

describe("simplified — dedupe de PIX e order bumps (Achados 2 e 3)", () => {
  it("recusar o bump e depois aceitar (keyboard antigo tocado de novo) gera um PIX NOVO, não reaproveita o do valor sem bump", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({
      order_bumps: [{ id: "b1", name: "Bônus", price: 10, attached_plan_ids: ["p1"] }],
    });
    const r = await rows(bot.id, funnelId, chatId);
    const base = { bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, tg };

    // 1ª interação: recusa o bump → PIX só do plano (19.90), fica pendente.
    await simplified.handle({ ...base, callbackData: "sp_p1", callbackMessageId: 1 });
    await simplified.handle({ ...base, callbackData: "sb_no_p1", callbackMessageId: 2 });

    // 2ª interação (ex.: /start de novo, keyboard antigo ainda vivo no chat):
    // desta vez aceita o bump — refKey muda (embute o bump), não pode reusar
    // o PIX de 19.90 pro total de 29.90.
    await simplified.handle({ ...base, callbackData: "sp_p1", callbackMessageId: 3 });
    await simplified.handle({ ...base, callbackData: "sb_yes_p1", callbackMessageId: 4 });

    const db = await testDb();
    const pays = await db.select().from(payments);
    expect(pays.length).toBe(2);
    expect(pays.map((p) => p.amount).sort((a, b) => a - b)).toEqual([1990, 2990]);
  });

  it("clicar 2x no MESMO plano+bump reaproveita 1 único PIX (Achado 2)", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({
      order_bumps: [{ id: "b1", name: "Bônus", price: 10, attached_plan_ids: ["p1"] }],
    });
    const r = await rows(bot.id, funnelId, chatId);
    const base = { bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, tg };
    await simplified.handle({ ...base, callbackData: "sp_p1", callbackMessageId: 1 });
    await simplified.handle({ ...base, callbackData: "sb_yes_p1", callbackMessageId: 2 });
    // Reentrega do mesmo clique (double-tap / reentrega at-least-once do update).
    await simplified.handle({ ...base, callbackData: "sb_yes_p1", callbackMessageId: 3 });
    const db = await testDb();
    const pays = await db.select().from(payments);
    expect(pays.length).toBe(1);
    expect(pays[0].amount).toBe(2990);
  });
});

describe("simplified — falha ao gerar PIX (Achado 4)", () => {
  it("sem gateway configurado: mensagem amigável + botão 'tentar de novo' que refaz o mesmo clique", async () => {
    const bot = await createBot();
    const config = { payment: {}, plans: [{ id: "p1", name: "Plano Pro", price: 19.9 }] };
    const funnelId = await createSimplifiedFunnel({ userId: bot.userId, botId: bot.id, config });
    const chatId = BigInt(900 + Math.floor(Math.random() * 1e6));
    await createLead(bot.id, chatId);
    const r = await rows(bot.id, funnelId, chatId);

    const handled = await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 1, tg });
    expect(handled).toBe(true);
    const db = await testDb();
    expect((await db.select().from(payments)).length).toBe(0);
    expect(getSentMessages().some((m) => m.includes("Pagamento indisponível"))).toBe(true);
    const kb = lastKeyboard();
    // O lead não fica sem saída: o botão reproduz o MESMO clique (sp_p1).
    expect(kb.some((row) => row[0].callback_data === "sp_p1")).toBe(true);
  });
});

describe("simplified — escape de HTML (Achado 5)", () => {
  it("first_name do lead com caractere de HTML não quebra o welcome (parse_mode HTML)", async () => {
    rejectUnescapedTelegramHtml(true);
    const { bot, funnelId, chatId } = await baseFunnel({ welcome: { text: "Olá {{first_name}}!" } });
    const db = await testDb();
    await db.update(leads).set({ firstName: "Ana & Cia" }).where(eq(leads.telegramChatId, chatId));
    const r = await rows(bot.id, funnelId, chatId);
    const handled = await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: "/start", callbackData: null, callbackMessageId: null, tg });
    expect(handled).toBe(true);
    expect(getSentMessages().some((m) => m.includes("Olá Ana &amp; Cia!"))).toBe(true);
  });

  it("texto do order bump com & não aborta o card (mesmo tratamento do funil de fluxo)", async () => {
    rejectUnescapedTelegramHtml(true);
    const { bot, funnelId, chatId } = await baseFunnel({
      order_bumps: [{ id: "b1", name: "Bônus", price: 10, attached_plan_ids: ["p1"] }],
      order_bumps_intro_text: "Leva A & B?",
    });
    const r = await rows(bot.id, funnelId, chatId);
    const handled = await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 1, tg });
    expect(handled).toBe(true);
    expect(getSentMessages().some((m) => m.includes("Leva A &amp; B?"))).toBe(true);
  });
});

describe("simplified — pausa manual (Achado 6)", () => {
  it("lead pausado (lead_progress.status = paused_manual) não recebe nenhuma automação do simplificado", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({ welcome: { text: "Bem-vindo!" } });
    const r = await rows(bot.id, funnelId, chatId);
    // 1ª interação: cria a linha de progresso (o simplificado é stateless e só
    // ganha essa linha na 1ª mensagem — é nela que o pause manual grava o estado).
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: "/start", callbackData: null, callbackMessageId: null, tg });
    const db = await testDb();
    await db.update(leadProgress).set({ status: "paused_manual" }).where(eq(leadProgress.leadId, r.lead.id));

    const before = getSentMessages().length;
    const handled = await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 2, tg });
    expect(handled).toBe(true); // engoliu o clique — não gerou PIX nem respondeu
    expect(getSentMessages().length).toBe(before);
    expect((await db.select().from(payments)).length).toBe(0);
  });

  it("lead pausado não recebe upsell/downsell agendado — a tarefa é marcada 'skipped'", async () => {
    const { bot, funnelId, chatId } = await baseFunnel({
      upsells: [{ id: "u1", name: "Upgrade", price: 30, delay_minutes: 0 }],
    });
    const r = await rows(bot.id, funnelId, chatId);
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: "sp_p1", callbackMessageId: 9, tg });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    await simplified.deliverPaid((await payRepo.findById(pay.id))!);
    await db.update(leadProgress).set({ status: "paused_manual" }).where(eq(leadProgress.leadId, r.lead.id));

    const before = getSentMessages().length;
    const n = await simplified.processDueTasks();
    expect(n).toBe(0); // pausado não conta como "processado"
    expect(getSentMessages().length).toBe(before);
    const [task] = await db.select().from(simplifiedScheduledTasks).where(eq(simplifiedScheduledTasks.kind, "upsell"));
    expect(task.status).toBe("skipped");
  });
});
