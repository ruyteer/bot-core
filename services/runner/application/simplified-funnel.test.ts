import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { ExecuteSimplifiedFunnelUseCase } from "./execute-simplified-funnel.use-case.js";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { TelegramClient } from "./telegram.client.js";
import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { testDb } from "../../../test/helpers/db.js";
import { bots, leads, funnels, payments, simplifiedScheduledTasks } from "../../shared/schema/index.js";
import { createBot, createGateway, createSimplifiedFunnel, createLead, startUpdate, callbackUpdate } from "../../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls } from "../../../test/helpers/fetch-mock.js";

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
    await simplified.handle({ bot: r.bot, lead: r.lead, chatId: chatId.toString(), funnel: r.funnel, text: null, callbackData: `sc_accept_${funnelId}`, callbackMessageId: 5, tg });
    kb = lastKeyboard();
    expect(kb.some((row) => row[0].callback_data === "sp_p1")).toBe(true);
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
