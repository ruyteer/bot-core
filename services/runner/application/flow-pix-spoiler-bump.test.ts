import { describe, it, expect } from "vitest";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { testDb } from "../../../test/helpers/db.js";
import { payments } from "../../shared/schema/index.js";
import {
  createBot, createGateway, createFlowFunnel, startUpdate, callbackUpdate,
} from "../../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls, rejectUnescapedTelegramHtml } from "../../../test/helpers/fetch-mock.js";

const useCase = new ExecuteFlowStepUseCase();
const payRepo = new PaymentDrizzleRepository();

async function setupOffer(opts: {
  offer: Record<string, unknown>;
  nodeExtra?: Record<string, unknown>;
  extraConns?: Array<{ from: string; to: string; handle: string }>;
}) {
  const bot = await createBot();
  const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
  const offer = { gateway_id: gwId, ...opts.offer };
  const { funnelId, nodeIds } = await createFlowFunnel({
    userId: bot.userId, botId: bot.id,
    nodes: [
      { key: "t", type: "trigger" },
      { key: "off", type: "offer", content: { offers: [offer], unpaid_timeout: 5, ...opts.nodeExtra } },
      { key: "paid", type: "message", content: { message: "ACESSO-LIBERADO" } },
    ],
    connections: [
      { from: "t", to: "off" },
      ...(opts.extraConns ?? []),
    ],
  });
  return { bot, funnelId, nodeIds, offer };
}

function bumpCallback(kind: "y" | "n" | "1"): string {
  const bumpMsg = getTelegramCalls("sendMessage").find((c) => {
    const kb = (c.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
    return kb?.flat().some((b) => b.callback_data?.startsWith(`ob:${kind}:`));
  });
  const kb = (bumpMsg!.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
  return kb.flat().find((b) => b.callback_data?.startsWith(`ob:${kind}:`))!.callback_data!;
}

function offerBuyCallback(): string {
  for (const method of ["sendMessage", "sendPhoto"] as const) {
    for (const call of getTelegramCalls(method)) {
      const kb = (call.body.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
      const hit = kb?.flat().find((b) => typeof b.callback_data === "string" && b.callback_data.startsWith("o:"));
      if (hit?.callback_data) return hit.callback_data;
    }
  }
  throw new Error("nenhum botão o:<nó>:<i> nas chamadas do Telegram");
}

describe("flow PIX texts", () => {
  it("sem pix_* gera o caption legado 💠 e só o <code> (mesmas chamadas de antes)", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(801) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(801, "offer:0") });

    const photos = getTelegramCalls("sendPhoto");
    expect(photos.length).toBe(1);
    expect(photos[0].body.caption).toBe(
      "💠 <b>Curso</b>\nValor: R$ 19.90\n\nPague com o PIX copia-e-cola abaixo 👇",
    );
    expect(photos[0].body.reply_markup).toBeUndefined();
    const copy = getTelegramCalls("sendMessage").filter((c) => String(c.body.text ?? "").includes("<code>"));
    expect(copy).toHaveLength(1);
    expect(copy[0].body.text).toMatch(/^<code>PIXCODE_/);
    expect(getTelegramCalls("sendMessage").filter((c) => String(c.body.text ?? "").includes("Ou copie"))).toHaveLength(0);
  });

  it("com pix_qr_caption / pix_copy_text / pix_after_text substitui {produto} {valor} e envia o after", async () => {
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: "promo", button_text: "Comprar" },
      nodeExtra: {
        pix_qr_caption: "QR {produto} {valor}",
        pix_copy_text: "Copia {produto}",
        pix_after_text: "Depois {produto}",
      },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(802, { firstName: "Ana" }) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(802, "offer:0") });

    const photos = getTelegramCalls("sendPhoto");
    expect(photos[0].body.caption).toMatch(/QR Curso R\$\s*19,90/);
    const msgs = getSentMessages();
    expect(msgs.some((m) => m.includes("Copia Curso"))).toBe(true);
    expect(msgs.some((m) => m.includes("Depois Curso"))).toBe(true);
  });

  it("pix_send_mode combined junta QR + código numa sendPhoto", async () => {
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 10, callback: "promo", button_text: "Comprar" },
      nodeExtra: {
        pix_send_mode: "combined",
        pix_qr_caption: "Pague {produto}",
        pix_copy_text: "cola aqui",
      },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(803) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(803, "offer:0") });

    const photos = getTelegramCalls("sendPhoto");
    expect(photos).toHaveLength(1);
    expect(String(photos[0].body.caption)).toContain("Pague Curso");
    expect(String(photos[0].body.caption)).toContain("<code>");
    expect(String(photos[0].body.caption)).toContain("cola aqui");
    expect(photos[0].body.reply_markup).toBeDefined();
  });
});

describe("flow media spoiler", () => {
  it("sem has_spoiler: sendPhoto não leva has_spoiler (mesmo corpo de antes)", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "media", content: { media_type: "image", url: "https://a/1.jpg", caption: "x" } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(811) });
    const photos = getTelegramCalls("sendPhoto");
    expect(photos).toHaveLength(1);
    expect(photos[0].body.has_spoiler).toBeUndefined();
  });

  it("has_spoiler true no nó media vai em sendPhoto", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "media", content: { media_type: "image", url: "https://a/1.jpg", caption: "segredo", has_spoiler: true } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(812) });
    const photos = getTelegramCalls("sendPhoto");
    expect(photos).toHaveLength(1);
    expect(photos[0].body.has_spoiler).toBe(true);
  });

  it("álbum: has_spoiler por item", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        {
          key: "m", type: "media",
          content: {
            media_type: "image", url: "https://a/1.jpg", has_spoiler: true,
            extra_items: [{ media_type: "image", url: "https://a/2.jpg" }],
          },
        },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(813) });
    const groups = getTelegramCalls("sendMediaGroup");
    expect(groups).toHaveLength(1);
    const media = groups[0].body.media as Array<{ has_spoiler?: boolean }>;
    expect(media[0].has_spoiler).toBe(true);
    expect(media[1].has_spoiler).toBeUndefined();
  });

  it("bloco media de message com has_spoiler", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        {
          key: "m", type: "message",
          content: {
            blocks: [{ type: "media", media_type: "image", url: "https://a/b.jpg", has_spoiler: true }],
          },
        },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(814) });
    expect(getTelegramCalls("sendPhoto")[0].body.has_spoiler).toBe(true);
  });
});

describe("flow order bump — mesmo PIX", () => {
  const bump = {
    product_id: "b1",
    product_name: "Brinde",
    price: 10,
    delivery_type: "content",
    delivery_url: "https://brinde",
  };

  it("oferta com bumps NÃO gera PIX no clique — manda o card", async () => {
    const { bot } = await setupOffer({
      offer: {
        product_name: "Curso", price: 19.9, callback: "promo", button_text: "Comprar",
        bumps: [bump], bump_message: "Leva o brinde?",
      },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(821) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(821, "offer:0") });

    expect(getTelegramCalls("sendPhoto")).toHaveLength(0);
    const db = await testDb();
    expect(await db.select().from(payments)).toHaveLength(0);
    expect(getSentMessages().some((m) => m.includes("Leva o brinde?"))).toBe(true);
  });

  it("recusar bump gera PIX só da oferta, sale_type offer", async () => {
    const { bot } = await setupOffer({
      offer: {
        product_name: "Curso", price: 19.9, callback: "promo", button_text: "Comprar",
        bumps: [bump],
      },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(822) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(822, "offer:0") });
    const no = bumpCallback("n");

    await useCase.execute({ botId: bot.id, update: callbackUpdate(822, no) });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay.amount).toBe(1990);
    expect(pay.saleType).toBe("offer");
    expect(pay.simplifiedCtx).toBeNull();
  });

  it("aceitar bump soma no mesmo PIX e entrega o extra no pago", async () => {
    const { bot } = await setupOffer({
      offer: {
        product_name: "Curso", price: 19.9, callback: "promo", button_text: "Comprar",
        product_type: "content", delivery_url: "https://curso",
        bumps: [bump],
      },
      extraConns: [{ from: "off", to: "paid", handle: "promo__paid" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(823) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(823, "offer:0") });
    const yes = bumpCallback("y");

    await useCase.execute({ botId: bot.id, update: callbackUpdate(823, yes) });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay.amount).toBe(2990); // 19.90 + 10
    expect(pay.saleType).toBe("offer");
    expect((pay.simplifiedCtx as { items: unknown[] } | null)?.items).toHaveLength(1);

    await useCase.handlePaidOffer((await payRepo.findById(pay.id))!);
    const msgs = getSentMessages();
    expect(msgs.some((m) => m.includes("curso"))).toBe(true);
    expect(msgs.some((m) => m.includes("brinde") || m.includes("Brinde"))).toBe(true);
  });

  it("oferta SEM bumps continua gerando PIX no clique (regressão)", async () => {
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 30, callback: "promo", button_text: "Comprar" },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(824) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(824, "offer:0") });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay.amount).toBe(3000);
    expect(getTelegramCalls("sendPhoto").length).toBeGreaterThan(0);
  });

  it("clique de produção o:<nó>:<i> também manda o card (não só o legado offer:0)", async () => {
    const { bot } = await setupOffer({
      offer: {
        product_name: "Curso", price: 19.9, callback: "promo", button_text: "Comprar",
        bumps: [bump], bump_message: "Leva o brinde?",
      },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(825) });
    const buy = offerBuyCallback();
    expect(buy).toMatch(/^o:[a-z0-9]{1,8}:0$/);
    await useCase.execute({ botId: bot.id, update: callbackUpdate(825, buy) });
    expect(await (await testDb()).select().from(payments)).toHaveLength(0);
    expect(getSentMessages().some((m) => m.includes("Leva o brinde?"))).toBe(true);
    expect(bumpCallback("y")).toMatch(/^ob:y:/);
  });

  it("mensagem com & não aborta o card — Telegram rejeita HTML malformado", async () => {
    rejectUnescapedTelegramHtml(true);
    const { bot } = await setupOffer({
      offer: {
        product_name: "Curso", price: 19.9, callback: "promo", button_text: "Comprar",
        bumps: [bump], bump_message: "Leva A & B?",
      },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(826) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(826, offerBuyCallback()) });
    expect(await (await testDb()).select().from(payments)).toHaveLength(0);
    expect(getSentMessages().some((m) => m.includes("A &amp; B"))).toBe(true);
  });

  it("template legado {bump_nome} aparece resolvido no botão do card", async () => {
    const { bot } = await setupOffer({
      offer: {
        product_name: "Curso", price: 19.9, callback: "promo", button_text: "Comprar",
        bumps: [bump],
        bump_button_template: "{bump_nome} (+{bump_preco})",
      },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(827) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(827, offerBuyCallback()) });
    const bumpMsg = getTelegramCalls("sendMessage").find((c) => {
      const kb = (c.body.reply_markup as { inline_keyboard?: { text?: string; callback_data?: string }[][] } | undefined)?.inline_keyboard;
      return kb?.flat().some((b) => b.callback_data?.startsWith("ob:y:"));
    });
    const labels = (bumpMsg!.body.reply_markup as { inline_keyboard: { text?: string }[][] }).inline_keyboard.flat().map((b) => b.text ?? "");
    expect(labels.some((t) => t.includes("Brinde") && !t.includes("{bump_nome}"))).toBe(true);
  });
});
