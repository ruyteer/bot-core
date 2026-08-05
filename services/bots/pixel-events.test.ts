// Envio server-side dos pixels (Meta CAPI, TikTok Events API, Kwai S2S).
// Nada disso existia: o painel salvava o pixel e o botão de teste enfileirava
// um evento "pending" que NENHUM código enviava. Cobre o pipeline novo:
// enfileirar no /start (Lead) e no paid (Purchase) → dispatcher envia → log.
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createBot, createFlowFunnel, createGateway, textUpdate } from "../../test/helpers/seed.js";
import { getOtherCalls, forceGatewayError } from "../../test/helpers/fetch-mock.js";
import { encrypt } from "../shared/crypto.js";
import { conversionEvents, trackingPixels, payments, leads, bots } from "../shared/schema/index.js";
import { enqueuePixelEvents, processPendingConversionEvents } from "./application/pixel-events.js";
import { registerTrackingClick } from "../leads/application/tracking-click.js";
import { ExecuteFlowStepUseCase } from "../runner/application/execute-flow-step.use-case.js";
import { processWebhookEvent } from "../payments/webhooks.js";

const runner = new ExecuteFlowStepUseCase();

async function addPixel(botId: string, provider: string, token = "tok_secret"): Promise<void> {
  const db = await testDb();
  await db.insert(trackingPixels).values({
    botId, provider, pixelId: `px_${provider}`, accessToken: encrypt(token), isActive: true,
  });
}

async function botWithFunnel() {
  const bot = await createBot();
  const db = await testDb();
  await db.update(bots).set({ telegramUsername: "meubot" }).where(eq(bots.id, bot.id));
  await createFlowFunnel({
    userId: bot.userId,
    botId:  bot.id,
    nodes: [
      { key: "trigger", type: "trigger" },
      { key: "msg", type: "message", content: { message: "Oi!" } },
    ],
    connections: [{ from: "trigger", to: "msg" }],
  });
  return bot;
}

const callsTo = (frag: string) => getOtherCalls().filter((c) => c.url.includes(frag));

describe("enqueue + dispatcher", () => {
  it("primeiro /start enfileira Lead para cada pixel ativo; dispatcher envia", async () => {
    const bot = await botWithFunnel();
    await addPixel(bot.id, "facebook");
    await addPixel(bot.id, "tiktok");
    await addPixel(bot.id, "kwai");

    await runner.execute({ botId: bot.id, update: textUpdate(7001, "/start") });

    const db = await testDb();
    const pending = await db.select().from(conversionEvents);
    expect(pending).toHaveLength(3);
    expect(pending.every((e) => e.status === "pending" && e.eventName === "Lead")).toBe(true);

    // Segundo /start do MESMO lead não duplica o Lead.
    await runner.execute({ botId: bot.id, update: textUpdate(7001, "/start") });
    expect(await db.select().from(conversionEvents)).toHaveLength(3);

    const n = await processPendingConversionEvents();
    expect(n).toBe(3);

    // Meta e TikTok saem mesmo sem click id; Kwai sem clickid falha com motivo.
    expect(callsTo("graph.facebook.com")).toHaveLength(1);
    expect(callsTo("business-api.tiktok.com")).toHaveLength(1);
    expect(callsTo("adsnebula.com")).toHaveLength(0);

    const after = await db.select().from(conversionEvents);
    const byProvider = Object.fromEntries(after.map((e) => [e.provider, e]));
    expect(byProvider.facebook.status).toBe("sent");
    expect(byProvider.facebook.httpStatus).toBe(200);
    expect(byProvider.tiktok.status).toBe("sent");
    expect(byProvider.kwai.status).toBe("failed");
    expect(byProvider.kwai.errorMessage).toMatch(/clickid/i);
  });

  it("payload da Meta leva external_id, fbc do clique e event_id", async () => {
    const bot = await botWithFunnel();
    await addPixel(bot.id, "facebook");
    const { url } = (await registerTrackingClick({
      botId: bot.id, utmSource: "facebook", fbclid: "IwARtest", clientIp: "1.2.3.4", userAgent: "UA",
    }))!;
    const start = new URL(url).searchParams.get("start")!;

    await runner.execute({ botId: bot.id, update: textUpdate(7002, `/start ${start}`) });
    await processPendingConversionEvents();

    const call = callsTo("graph.facebook.com")[0];
    expect(call).toBeDefined();
    const data = (call.body as { data: Array<Record<string, any>> }).data[0];
    expect(data.event_name).toBe("Lead");
    expect(data.event_id).toBeTruthy();
    expect(data.user_data.external_id).toHaveLength(1);
    expect(data.user_data.fbc).toMatch(/^fb\.1\.\d+\.IwARtest$/);
    expect(data.user_data.client_ip_address).toBe("1.2.3.4");
  });

  it("Purchase no webhook paid: TikTok CompletePayment com value e Kwai EVENT_PURCHASE com clickid", async () => {
    const bot = await botWithFunnel();
    await addPixel(bot.id, "tiktok");
    await addPixel(bot.id, "kwai");
    const db = await testDb();

    // Lead chega por link do Kwai (clickid capturado pelo /r).
    const { url } = (await registerTrackingClick({
      botId: bot.id, utmSource: "kwai", ttclid: "ttc_1", kwaiClickId: "kwclick_1",
    }))!;
    const start = new URL(url).searchParams.get("start")!;
    await runner.execute({ botId: bot.id, update: textUpdate(7003, `/start ${start}`) });
    // Limpa os Leads enfileirados para isolar o Purchase.
    await processPendingConversionEvents();
    const before = getOtherCalls().length;

    const [lead] = await db.select().from(leads);
    const gatewayId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const [payment] = await db.insert(payments).values({
      userId: bot.userId, botId: bot.id, leadId: lead.id, gatewayId,
      amount: 970, status: "pending", externalId: "ext_px_1",
    }).returning();

    await processWebhookEvent(
      { provider: "buckpay", externalId: "ext_px_1", event: "paid", status: "paid", amount: 970 },
      {},
    );

    const evs = await db.select().from(conversionEvents)
      .where(and(eq(conversionEvents.paymentId, payment.id)));
    expect(evs).toHaveLength(2);

    await processPendingConversionEvents();

    const tk = getOtherCalls().slice(before).find((c) => c.url.includes("tiktok"));
    expect(tk).toBeDefined();
    const tkData = (tk!.body as { data: Array<Record<string, any>> }).data[0];
    expect(tkData.event).toBe("CompletePayment");
    expect(tkData.properties.value).toBe(9.7);
    expect(tkData.user.ttclid).toBe("ttc_1");

    const kw = getOtherCalls().slice(before).find((c) => c.url.includes("adsnebula"));
    expect(kw).toBeDefined();
    expect((kw!.body as Record<string, unknown>).event_name).toBe("EVENT_PURCHASE");
    expect((kw!.body as Record<string, unknown>).clickid).toBe("kwclick_1");
    expect((kw!.body as Record<string, unknown>).pixelId).toBe("px_kwai");
  });

  it("erro da plataforma marca failed com o corpo da resposta no log", async () => {
    const bot = await botWithFunnel();
    await addPixel(bot.id, "facebook");
    forceGatewayError("graph.facebook.com");

    await enqueuePixelEvents(bot.id, "PageView", {});
    await processPendingConversionEvents();

    const db = await testDb();
    const [ev] = await db.select().from(conversionEvents);
    expect(ev.status).toBe("failed");
    expect(ev.httpStatus).toBe(400);
    expect(ev.errorMessage).toMatch(/forced error/);
  });

  it("pixel inativo não enfileira; sem access token falha com motivo claro", async () => {
    const bot = await botWithFunnel();
    const db = await testDb();
    await db.insert(trackingPixels).values({ botId: bot.id, provider: "facebook", pixelId: "px", accessToken: null, isActive: true });
    await db.insert(trackingPixels).values({ botId: bot.id, provider: "tiktok", pixelId: "px2", accessToken: encrypt("t"), isActive: false });

    const n = await enqueuePixelEvents(bot.id, "PageView", {});
    expect(n).toBe(1); // só o facebook ativo

    await processPendingConversionEvents();
    const [ev] = await db.select().from(conversionEvents);
    expect(ev.status).toBe("failed");
    expect(ev.errorMessage).toMatch(/access token/i);
  });
});
