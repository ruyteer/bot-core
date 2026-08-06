import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { testDb } from "../../../test/helpers/db.js";
import { payments, scheduledDelays, leads, funnelOffers } from "../../shared/schema/index.js";
import {
  createBot, createGateway, createFlowFunnel, startUpdate, callbackUpdate,
} from "../../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls } from "../../../test/helpers/fetch-mock.js";

const useCase = new ExecuteFlowStepUseCase();
const payRepo = new PaymentDrizzleRepository();

async function setupOffer(opts: { offer: Record<string, unknown>; extraConns?: Array<{ from: string; to: string; handle: string }>; unpaidTimeout?: number }) {
  const bot = await createBot();
  const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
  const offer = { gateway_id: gwId, ...opts.offer };
  const { funnelId, nodeIds } = await createFlowFunnel({
    userId: bot.userId, botId: bot.id,
    nodes: [
      { key: "t", type: "trigger" },
      { key: "off", type: "offer", content: { offers: [offer], unpaid_timeout: opts.unpaidTimeout ?? 5 } },
      { key: "paid", type: "message", content: { message: "ACESSO-LIBERADO" } },
      { key: "pending", type: "message", content: { message: "AINDA-PENDENTE" } },
      { key: "noact", type: "message", content: { message: "NAO-CLICOU" } },
    ],
    connections: [
      { from: "t", to: "off" },
      ...(opts.extraConns ?? []),
    ],
  });
  return { bot, gwId, funnelId, nodeIds, offer };
}

describe("offer node — apresentação e compra", () => {
  it("apresenta botão de compra offer:0 e agenda __no_action", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" },
      extraConns: [{ from: "off", to: "noact", handle: `${handle}__no_action` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(700) });
    const presented = getTelegramCalls().find((c) => c.body.reply_markup);
    const kb = (presented!.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
    expect(kb[0][0].callback_data).toBe("offer:0");

    const db = await testDb();
    const delays = await db.select().from(scheduledDelays);
    expect(delays.length).toBe(1); // __no_action agendado
  });

  it("clique gera PIX em CENTAVOS, persiste payment e envia QR + copia-e-cola", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar", product_type: "content", delivery_url: "https://entrega" },
      extraConns: [
        { from: "off", to: "paid", handle: `${handle}__paid` },
        { from: "off", to: "noact", handle: `${handle}__no_action` },
      ],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(701) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(701, "offer:0") });

    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay).toBeDefined();
    expect(pay.amount).toBe(1990);               // 19.90 reais → 1990 centavos
    expect(pay.status).toBe("pending");
    expect(pay.paidHandle).toBe(`${handle}__paid`);
    expect(pay.pixCode).toBeTruthy();

    // QR (sendPhoto) + copia-e-cola (sendMessage com <code>)
    expect(getTelegramCalls("sendPhoto").length).toBeGreaterThan(0);
    expect(getSentMessages().some((m) => m.includes("<code>"))).toBe(true);
  });

  it("__no_action cancelado ao clicar; __pending agendado", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 30, callback: handle, button_text: "Comprar" },
      extraConns: [
        { from: "off", to: "pending", handle: `${handle}__pending` },
        { from: "off", to: "noact", handle: `${handle}__no_action` },
      ],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(702) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(702, "offer:0") });
    const db = await testDb();
    const pend = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    // só deve restar o __pending (1), o __no_action foi apagado
    expect(pend.length).toBe(1);
  });
});

describe("handlePaidOffer — entrega e retomada", () => {
  it("entrega conteúdo e retoma pelo ramo __paid", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 50, callback: handle, button_text: "Comprar", product_type: "content", delivery_url: "https://meu-produto" },
      extraConns: [{ from: "off", to: "paid", handle: `${handle}__paid` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(703) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(703, "offer:0") });

    const db = await testDb();
    const [pay] = await db.select().from(payments);
    const payment = await payRepo.findById(pay.id);
    await useCase.handlePaidOffer(payment!);

    const msgs = getSentMessages();
    expect(msgs.some((m) => m.includes("meu-produto"))).toBe(true); // entrega
    expect(msgs).toContain("ACESSO-LIBERADO");                       // retomou __paid
  });

  it("entrega VIP gera convite via createChatInviteLink", async () => {
    const handle = "vip";
    const { bot } = await setupOffer({
      offer: { product_name: "Grupo VIP", price: 99, callback: handle, button_text: "Entrar", product_type: "vip_group", telegram_group_id: "-100123", access_days: 30 },
      extraConns: [{ from: "off", to: "paid", handle: `${handle}__paid` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(704) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(704, "offer:0") });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    await useCase.handlePaidOffer((await payRepo.findById(pay.id))!);

    expect(getTelegramCalls("createChatInviteLink").length).toBe(1);
    // O link de convite agora vai num BOTÃO (reply_markup), não colado no texto.
    const withButton = getTelegramCalls("sendMessage").find((c) => {
      const kb = (c.body.reply_markup as { inline_keyboard?: Array<Array<{ url?: string }>> })?.inline_keyboard;
      return kb?.some((row) => row.some((b) => b.url?.includes("t.me/+testinvite")));
    });
    expect(withButton).toBeDefined();
    // e o link não deve mais aparecer cru no texto de nenhuma mensagem
    expect(getSentMessages().some((m) => m.includes("t.me/+testinvite"))).toBe(false);
  });
});

describe("ofertas embutidas em nó message (block.type=offer)", () => {
  it("apresenta botão e processa compra com handle do bloco", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { blocks: [
          { type: "text", message: "Veja a oferta" },
          { type: "offer", offers: [{ product_name: "X", price: 10, gateway_id: gwId, callback: "blk", button_text: "Quero" }] },
        ] } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(705) });
    const presented = getTelegramCalls().find((c) => c.body.reply_markup);
    expect(presented).toBeDefined();
    await useCase.execute({ botId: bot.id, update: callbackUpdate(705, "offer:0") });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay.amount).toBe(1000);
  });
});

describe("bcast_buy — compra de oferta avulsa (broadcast/remarketing)", () => {
  it("clique no botão bcast_buy gera PIX no valor da oferta e persiste payment", async () => {
    const bot = await createBot();
    await createGateway({ userId: bot.userId, provider: "buckpay" });
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990, productType: "content", deliveryUrl: "https://entrega" }).returning();
    await useCase.execute({ botId: bot.id, update: callbackUpdate(7200, `bcast_buy_${offer.id}`) });
    const [pay] = await db.select().from(payments);
    expect(pay).toBeDefined();
    expect(pay.amount).toBe(1990);
    expect(pay.offerId).toBe(offer.id);
    expect(getTelegramCalls("sendPhoto").length).toBeGreaterThan(0);
    expect(getSentMessages().some((m) => m.includes("<code>"))).toBe(true);
  });
});
