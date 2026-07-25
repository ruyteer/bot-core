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
import { forceGatewayError, getOtherCalls } from "../../test/helpers/fetch-mock.js";
import { createPixWithFallback } from "./application/create-pix-with-fallback.js";

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

// ── Split de monetização (40c da plataforma) ────────────────────────────────
describe("split por provider", () => {
  const CASES = [
    { p: "syncpay",  env: "SYNCPAY_SPLIT_USER_ID",  recv: "rc-sync",       urlPart: "cash-in" },
    { p: "nexuspag", env: "NEXUSPAG_SPLIT_USER_ID", recv: "rc-nex",        urlPart: "nexuspag" },
    { p: "wiinpay",  env: "WIINPAY_SPLIT_USER_ID",  recv: "rc-wiin",       urlPart: "wiinpay" },
    { p: "buckpay",  env: "BUCKPAY_SPLIT_EMAIL",    recv: "x@orion.app",   urlPart: "realtechdev" },
  ] as const;

  for (const c of CASES) {
    it(`${c.p}: sem secret NÃO envia split`, async () => {
      await createPix(c.p as any, "client", "secret", 600, "P", "https://wh");
      const call = getOtherCalls().find((x) => x.url.includes(c.urlPart));
      expect(call?.body?.split ?? call?.body?.splits).toBeUndefined();
    });

    it(`${c.p}: com secret envia split para o recebedor`, async () => {
      process.env[`TEST_SECRET_${c.env}`] = c.recv;
      try {
        await createPix(c.p as any, "client", "secret", 600, "P", "https://wh");
        const call = getOtherCalls().find((x) => x.url.includes(c.urlPart));
        const split = call?.body?.split ?? call?.body?.splits;
        expect(split).toBeDefined();
        expect(JSON.stringify(split)).toContain(c.recv);
      } finally {
        delete process.env[`TEST_SECRET_${c.env}`];
      }
    });
  }

  it("syncpay: percentual inteiro arredonda pra cima (600c → 7%)", async () => {
    process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID = "rc";
    try {
      await createPix("syncpay", "c", "s", 600, "P", "https://wh");
      const call = getOtherCalls().find((x) => x.url.includes("cash-in"));
      expect((call!.body!.split as any)[0].percentage).toBe(7); // ceil(40/600*100)=7
    } finally { delete process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID; }
  });

  it("buckpay: basis points arredonda pra cima (600c → 667 bps)", async () => {
    process.env.TEST_SECRET_BUCKPAY_SPLIT_EMAIL = "x@y.com";
    try {
      await createPix("buckpay", "c", "s", 600, "P", "https://wh");
      const call = getOtherCalls().find((x) => x.url.includes("realtechdev"));
      expect((call!.body!.splits as any)[0].percentage_bps).toBe(667); // ceil(40/600*10000)
    } finally { delete process.env.TEST_SECRET_BUCKPAY_SPLIT_EMAIL; }
  });

  it("nexuspag/wiinpay: valor fixo de 40 centavos", async () => {
    process.env.TEST_SECRET_NEXUSPAG_SPLIT_USER_ID = "rc";
    process.env.TEST_SECRET_WIINPAY_SPLIT_USER_ID = "rc";
    try {
      await createPix("nexuspag", "c", "s", 600, "P", "https://wh");
      await createPix("wiinpay", "c", "s", 600, "P", "https://wh");
      const nx = getOtherCalls().find((x) => x.url.includes("nexuspag"));
      const wp = getOtherCalls().find((x) => x.url.includes("wiinpay"));
      expect((nx!.body!.split as any)[0].amount).toBe(0.4);
      expect((wp!.body!.split as any).value).toBe(0.4);
    } finally {
      delete process.env.TEST_SECRET_NEXUSPAG_SPLIT_USER_ID;
      delete process.env.TEST_SECRET_WIINPAY_SPLIT_USER_ID;
    }
  });
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

describe("GatewayDrizzleRepository — ordem de fallback por bot", () => {
  it("findChainForBot respeita a ordem configurada", async () => {
    const bot = await createBot();
    const a = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const b = await createGateway({ userId: bot.userId, provider: "syncpay" });
    await gwRepo.setChain(bot.id, bot.userId, [b, a]);
    const chain = await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id });
    expect(chain.map((g) => g.id)).toEqual([b, a]);
  });

  it("gateway desativado sai da cadeia mesmo estando na ordem", async () => {
    const bot = await createBot();
    const a = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const b = await createGateway({ userId: bot.userId, provider: "syncpay" });
    await gwRepo.setChain(bot.id, bot.userId, [a, b]);
    await gwRepo.toggle(a, bot.userId, false);
    const chain = await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id });
    expect(chain.map((g) => g.id)).toEqual([b]);
  });

  it("sem ordem configurada usa todos os gateways ativos do usuário", async () => {
    const bot = await createBot();
    const a = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const chain = await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id });
    expect(chain.map((g) => g.id)).toEqual([a]);
  });

  it("cadeia vazia quando o usuário não tem gateway", async () => {
    const bot = await createBot();
    expect(await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id })).toEqual([]);
  });

  it("setChain ignora gateway de outro usuário", async () => {
    const bot = await createBot();
    const other = await createBot();
    const mine = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const theirs = await createGateway({ userId: other.userId, provider: "syncpay" });
    await gwRepo.setChain(bot.id, bot.userId, [theirs, mine]);
    expect((await gwRepo.listChain(bot.id, bot.userId)).map((g) => g.id)).toEqual([mine]);
  });
});

describe("createPixWithFallback", () => {
  it("cai para o próximo gateway quando o primeiro falha", async () => {
    const bot = await createBot();
    const bad  = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const good = await createGateway({ userId: bot.userId, provider: "syncpay" });
    await gwRepo.setChain(bot.id, bot.userId, [bad, good]);
    forceGatewayError("realtechdev"); // BuckPay fora do ar

    const chain = await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id });
    const res = await createPixWithFallback(chain, {
      amountCents: 1500, description: "Curso",
      webhookUrl: (p) => `https://x/webhook/${p}`,
    });

    expect(res!.gateway.id).toBe(good);
    expect(res!.failures.map((f) => f.provider)).toEqual(["buckpay"]);
    expect(res!.pix.pixCode).toBeTruthy();
  });

  it("lança quando todos falham, com o motivo de cada um", async () => {
    const bot = await createBot();
    const a = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const b = await createGateway({ userId: bot.userId, provider: "nexuspag" });
    await gwRepo.setChain(bot.id, bot.userId, [a, b]);
    forceGatewayError("realtechdev");
    forceGatewayError("nexuspag");

    const chain = await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id });
    await expect(createPixWithFallback(chain, {
      amountCents: 1500, description: "Curso", webhookUrl: (p) => `https://x/webhook/${p}`,
    })).rejects.toThrow(/todos os gateways falharam/);
  });

  it("cadeia vazia retorna null (gateway não configurado)", async () => {
    const res = await createPixWithFallback([], {
      amountCents: 100, description: "X", webhookUrl: () => "https://x",
    });
    expect(res).toBeNull();
  });
});
