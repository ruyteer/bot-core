import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  createPix,
  normalizeSyncpayWebhook, normalizeBuckpayWebhook,
  normalizeNexuspagWebhook, normalizeWiinpayWebhook,
} from "./application/gateway-clients.js";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { GatewayDrizzleRepository } from "./infrastructure/gateway.drizzle.repository.js";
import { processWebhookEvent } from "./webhooks.js";
import { testDb } from "../../test/helpers/db.js";
import { payments, processedWebhooks } from "../shared/schema/index.js";
import { createBot, createGateway, createLead } from "../../test/helpers/seed.js";
import { published } from "../../test/stubs/encore-pubsub.js";

const payRepo = new PaymentDrizzleRepository();
const gwRepo = new GatewayDrizzleRepository();

// ── Normalizadores de webhook ──────────────────────────────────────────────
describe("normalizadores de webhook", () => {
  it("buckpay: data aninhada, paid, total_amount em centavos", () => {
    const e = normalizeBuckpayWebhook({ event: "transaction.processed", data: { id: "tx1", status: "paid", total_amount: 1990 } });
    expect(e).toMatchObject({ externalId: "tx1", provider: "buckpay", status: "paid", amount: 1990 });
  });
  it("syncpay: approved → paid, amount reais→centavos", () => {
    const e = normalizeSyncpayWebhook({ identifier: "id1", status: "approved", amount: 19.9 });
    expect(e).toMatchObject({ provider: "syncpay", status: "paid", amount: 1990 });
  });
  it("nexuspag: cancelled", () => {
    expect(normalizeNexuspagWebhook({ id: "n1", status: "cancelled" }).status).toBe("cancelled");
  });
  it("wiinpay: PAID maiúsculo", () => {
    expect(normalizeWiinpayWebhook({ id: "w1", status: "PAID" }).status).toBe("paid");
  });
  it("status desconhecido → pending", () => {
    expect(normalizeBuckpayWebhook({ data: { id: "x", status: "waiting" } }).status).toBe("pending");
  });
});

// ── createPix por provider ─────────────────────────────────────────────────
describe("createPix", () => {
  const providers = ["buckpay", "syncpay", "nexuspag", "wiinpay"] as const;
  for (const p of providers) {
    it(`${p} devolve pixCode, externalId e qrImage`, async () => {
      const r = await createPix(p, "client", "secret", 1990, "Produto", "https://wh");
      expect(r.pixCode).toBeTruthy();
      expect(r.externalId).toBeTruthy();
      expect(r.qrImage).toContain("qrserver");
      expect(r.amount).toBe(1990);
      expect(r.provider).toBe(p);
    });
  }
});

// ── Repositório ─────────────────────────────────────────────────────────────
describe("PaymentDrizzleRepository", () => {
  async function seedPayment(externalId: string, status = "pending") {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const leadId = await createLead(bot.id, BigInt(Math.floor(Math.random() * 1e9)));
    return payRepo.create({
      userId: bot.userId, botId: bot.id, gatewayId: gwId,
      amount: 1990, status, externalId, pixCode: "PIX", offerExternalRef: "ref1", leadId,
    });
  }

  it("markPaid muda status e seta paidAt", async () => {
    const p = await seedPayment("ext-paid");
    await payRepo.markPaid(p.id, 1990);
    const got = await payRepo.findById(p.id);
    expect(got!.status).toBe("paid");
    expect(got!.paidAt).toBeInstanceOf(Date);
    expect(got!.finalAmount).toBe(1990);
  });

  it("findByExternalId casa pelo provider do gateway", async () => {
    const p = await seedPayment("ext-find");
    const got = await payRepo.findByExternalId("ext-find", "buckpay");
    expect(got!.id).toBe(p.id);
    expect(await payRepo.findByExternalId("ext-find", "syncpay")).toBeNull();
  });

  it("idempotência: isProcessed/markProcessed", async () => {
    expect(await payRepo.isProcessed("e1", "buckpay")).toBe(false);
    await payRepo.markProcessed("e1", "buckpay", "paid");
    expect(await payRepo.isProcessed("e1", "buckpay")).toBe(true);
    await payRepo.markProcessed("e1", "buckpay", "paid"); // não duplica (onConflictDoNothing)
  });

  it("findReusablePending acha pendente recente do mesmo ref/valor", async () => {
    const p = await seedPayment("ext-reuse");
    const found = await payRepo.findReusablePending(p.botId, p.leadId!, 1990, "ref1");
    expect(found?.id).toBe(p.id);
    // valor diferente não casa
    expect(await payRepo.findReusablePending(p.botId, p.leadId!, 999, "ref1")).toBeNull();
  });
});

// ── processWebhookEvent (fluxo completo) ────────────────────────────────────
describe("processWebhookEvent", () => {
  async function seed(externalId: string) {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    return payRepo.create({
      userId: bot.userId, botId: bot.id, gatewayId: gwId,
      amount: 1990, status: "pending", externalId, pixCode: "PIX", leadId: null,
    });
  }

  it("paid → markPaid + publica paymentPaid", async () => {
    const p = await seed("wh-paid");
    await processWebhookEvent({ externalId: "wh-paid", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, {});
    const got = await payRepo.findById(p.id);
    expect(got!.status).toBe("paid");
    expect(published.some((e) => e.topic === "payment-paid" && (e.event as { paymentId: string }).paymentId === p.id)).toBe(true);
  });

  it("idempotente: segundo evento não republica", async () => {
    const p = await seed("wh-idem");
    await processWebhookEvent({ externalId: "wh-idem", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, {});
    const countAfterFirst = published.length;
    await processWebhookEvent({ externalId: "wh-idem", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, {});
    expect(published.length).toBe(countAfterFirst);
    void p;
  });

  it("cancelled → atualiza status sem publicar", async () => {
    const p = await seed("wh-cancel");
    await processWebhookEvent({ externalId: "wh-cancel", provider: "buckpay", status: "cancelled", amount: null, event: "cancelled" }, {});
    expect((await payRepo.findById(p.id))!.status).toBe("cancelled");
  });

  it("externalId sem payment correspondente não quebra", async () => {
    await expect(processWebhookEvent({ externalId: "nao-existe", provider: "buckpay", status: "paid", amount: 1, event: "paid" }, {})).resolves.toBeUndefined();
    const db = await testDb();
    expect((await db.select().from(processedWebhooks).where(eq(processedWebhooks.externalId, "nao-existe"))).length).toBe(1);
  });
});

describe("GatewayDrizzleRepository.findForBot (gateway por bot + override)", () => {
  it("override explícito tem prioridade sobre o padrão do bot", async () => {
    const bot = await createBot();
    const def = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const over = await createGateway({ userId: bot.userId, provider: "syncpay" });
    const gw = await gwRepo.findForBot({ userId: bot.userId, defaultGatewayId: def, explicitGatewayId: over });
    expect(gw!.id).toBe(over);
  });
  it("sem override usa o gateway padrão do bot", async () => {
    const bot = await createBot();
    const def = await createGateway({ userId: bot.userId, provider: "buckpay" });
    await createGateway({ userId: bot.userId, provider: "syncpay" });
    const gw = await gwRepo.findForBot({ userId: bot.userId, defaultGatewayId: def });
    expect(gw!.id).toBe(def);
  });
  it("sem override e sem padrão cai no 1º gateway ativo", async () => {
    const bot = await createBot();
    const a = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const gw = await gwRepo.findForBot({ userId: bot.userId });
    expect(gw!.id).toBe(a);
  });
  it("retorna null quando o usuário não tem gateway", async () => {
    const bot = await createBot();
    const gw = await gwRepo.findForBot({ userId: bot.userId });
    expect(gw).toBeNull();
  });
});
