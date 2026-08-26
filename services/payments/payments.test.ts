import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  createPix,
  normalizeSyncpayWebhook, normalizeBuckpayWebhook,
  normalizeNexuspagWebhook, normalizeWiinpayWebhook,
  __resetSyncpayWebhookCacheForTests,
} from "./application/gateway-clients.js";
import { resolveEffectiveSplit } from "./application/split-config.js";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { GatewayDrizzleRepository } from "./infrastructure/gateway.drizzle.repository.js";
import { processWebhookEvent } from "./webhooks.js";
import { testDb } from "../../test/helpers/db.js";
import {
  payments, processedWebhooks, paymentWebhookLogs, platformConfig,
  paymentRevenueCredits, referrals, referralCommissions, userRoles,
} from "../shared/schema/index.js";
import { createBot, createGateway, createLead, createProfile } from "../../test/helpers/seed.js";
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
  // Evento real de produção (2026-08-14): a SyncPay confirma o PIX com
  // status "PAID_OUT" (data aninhada em `data`), não "paid"/"completed" —
  // sem isso reconhecido, o webhook chegava mas a venda nunca era aprovada.
  it("syncpay: PAID_OUT (payload real, data aninhada) → paid", () => {
    const e = normalizeSyncpayWebhook({
      data: { id: "212c6c2b-81e8-492d-98e5-1296ed181a4a", status: "PAID_OUT", amount: 5.9 },
    });
    expect(e).toMatchObject({ provider: "syncpay", status: "paid", amount: 590 });
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

// ── SyncPay: registro do webhook na conta ───────────────────────────────────
// A SyncPay ignora o webhook_url do cash-in: sem POST /webhooks registrado na
// conta, a confirmação de venda nunca chega. O evento registrado é "all":
// registrar só "cashin" comprovadamente não entrega a confirmação de pagamento.
describe("syncpay — registro automático do webhook", () => {
  it("primeiro PIX registra o webhook; o segundo usa o cache e não repete", async () => {
    __resetSyncpayWebhookCacheForTests();
    await createPix("syncpay", "client_a", "secret", 1990, "Produto", "https://core/payments/webhook/syncpay");

    const posts = getOtherCalls().filter((c) =>
      c.url.includes("/api/partner/v1/webhooks") && c.body?.event === "all");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      url: "https://core/payments/webhook/syncpay",
      event: "all",
      trigger_all_products: true,
    });

    await createPix("syncpay", "client_a", "secret", 500, "Outro", "https://core/payments/webhook/syncpay");
    const postsAfter = getOtherCalls().filter((c) =>
      c.url.includes("/api/partner/v1/webhooks") && c.body?.event === "all");
    expect(postsAfter).toHaveLength(1); // cache — não registra de novo
  });

  it("falha no registro não bloqueia a geração do PIX", async () => {
    __resetSyncpayWebhookCacheForTests();
    forceGatewayError("/api/partner/v1/webhooks");
    const r = await createPix("syncpay", "client_b", "secret", 1990, "Produto", "https://wh");
    expect(r.pixCode).toBeTruthy(); // PIX sai mesmo com webhook não registrado
  });
});

// ── Split de monetização — repasse do objeto resolvido pro body do provider ──
// createPix não decide mais split sozinho (era a causa raiz do bug: cada
// consumidor tinha sua própria lógica); ele só repassa o split já resolvido.
// A decisão em si (precedência admin/USER_SPLIT_FEE_CENTS/<GW>_SPLIT_*/secret)
// é coberta abaixo em "resolveEffectiveSplit — precedência do split efetivo".
describe("createPix — split efetivo (repasse pro body do provider)", () => {
  const CASES = [
    { p: "syncpay",  recv: "rc-sync",     urlPart: "cash-in" },
    { p: "nexuspag", recv: "rc-nex",      urlPart: "nexuspag" },
    { p: "wiinpay",  recv: "rc-wiin",     urlPart: "wiinpay" },
    { p: "buckpay",  recv: "x@orion.app", urlPart: "realtechdev" },
  ] as const;

  for (const c of CASES) {
    it(`${c.p}: sem split (omitido) NÃO envia split`, async () => {
      await createPix(c.p as any, "client", "secret", 600, "P", "https://wh");
      const call = getOtherCalls().find((x) => x.url.includes(c.urlPart));
      expect(call?.body?.split ?? call?.body?.splits).toBeUndefined();
    });

    it(`${c.p}: com split resolvido envia para o recebedor`, async () => {
      await createPix(c.p as any, "client", "secret", 600, "P", "https://wh", { split: { receiver: c.recv, cents: 40 } });
      const call = getOtherCalls().find((x) => x.url.includes(c.urlPart));
      const split = call?.body?.split ?? call?.body?.splits;
      expect(split).toBeDefined();
      expect(JSON.stringify(split)).toContain(c.recv);
    });
  }

  it("syncpay: percentual inteiro arredonda pra cima (600c, alvo 40c → 7%)", async () => {
    await createPix("syncpay", "c", "s", 600, "P", "https://wh", { split: { receiver: "rc", cents: 40 } });
    const call = getOtherCalls().find((x) => x.url.includes("cash-in"));
    expect((call!.body!.split as any)[0].percentage).toBe(7); // ceil(40/600*100)=7
  });

  it("syncpay: percentual recalcula pro valor efetivo (600c, alvo 150c → 25%)", async () => {
    await createPix("syncpay", "c", "s", 600, "P", "https://wh", { split: { receiver: "rc", cents: 150 } });
    const call = getOtherCalls().find((x) => x.url.includes("cash-in"));
    expect((call!.body!.split as any)[0].percentage).toBe(25); // ceil(150/600*100)=25
  });

  it("buckpay: split em valor fixo, exatamente os centavos resolvidos", async () => {
    await createPix("buckpay", "c", "s", 600, "P", "https://wh", { split: { receiver: "x@y.com", cents: 40 } });
    const call = getOtherCalls().find((x) => x.url.includes("realtechdev"));
    expect((call!.body!.splits as any)[0].amount_cents).toBe(40);
  });

  it("nexuspag/wiinpay: valor fixo em reais = centavos resolvidos / 100", async () => {
    await createPix("nexuspag", "c", "s", 600, "P", "https://wh", { split: { receiver: "rc", cents: 40 } });
    await createPix("wiinpay", "c", "s", 600, "P", "https://wh", { split: { receiver: "rc", cents: 40 } });
    const nx = getOtherCalls().find((x) => x.url.includes("nexuspag"));
    const wp = getOtherCalls().find((x) => x.url.includes("wiinpay"));
    expect((nx!.body!.split as any)[0].amount).toBe(0.4);
    expect((wp!.body!.split as any).value).toBe(0.4);
  });

  it("split null (resolvido fora como admin) NÃO envia split mesmo com secret configurado", async () => {
    process.env.TEST_SECRET_WIINPAY_SPLIT_USER_ID = "rc";
    try {
      await createPix("wiinpay", "c", "s", 600, "P", "https://wh", { split: null });
      const wp = getOtherCalls().find((x) => x.url.includes("wiinpay"));
      expect(wp!.body!.split).toBeUndefined();
    } finally { delete process.env.TEST_SECRET_WIINPAY_SPLIT_USER_ID; }
  });
});

// ── resolveEffectiveSplit — a decisão em si (precedência) ───────────────────
// Fonte única de verdade que faltava: o admin escrevia USER_SPLIT_FEE_CENTS_*
// e <GW>_SPLIT_ENABLED/_USER_ID/_FEE_CENTS em platform_config, mas nada disso
// era lido — o PIX real só olhava os secrets do Encore. Ver
// services/payments/application/split-config.ts para a precedência completa.
describe("resolveEffectiveSplit — precedência do split efetivo", () => {
  const PROVIDERS = ["syncpay", "buckpay", "nexuspag", "wiinpay"] as const;
  const RECEIVER_ENV: Record<(typeof PROVIDERS)[number], string> = {
    syncpay:  "SYNCPAY_SPLIT_USER_ID",
    nexuspag: "NEXUSPAG_SPLIT_USER_ID",
    wiinpay:  "WIINPAY_SPLIT_USER_ID",
    buckpay:  "BUCKPAY_SPLIT_EMAIL",
  };

  it("sem nenhuma config no painel: cai no secret + PLATFORM_SPLIT_CENTS (comportamento antigo)", async () => {
    process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID = "rc-fallback";
    try {
      const seller = await createProfile();
      expect(await resolveEffectiveSplit("syncpay", seller)).toEqual({ receiver: "rc-fallback", cents: 40 });
    } finally { delete process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID; }
  });

  it("sem secret e sem config nenhuma: sem split", async () => {
    const seller = await createProfile();
    expect(await resolveEffectiveSplit("syncpay", seller)).toBeNull();
  });

  it("admin da plataforma: sempre sem split, mesmo com <GW>_SPLIT_ENABLED=true configurado", async () => {
    const db = await testDb();
    const admin = await createProfile();
    await db.insert(userRoles).values({ userId: admin, role: "admin" });
    await db.insert(platformConfig).values({ key: "SYNCPAY_SPLIT_ENABLED", value: "true" });
    await db.insert(platformConfig).values({ key: "SYNCPAY_SPLIT_USER_ID", value: "rc" });
    expect(await resolveEffectiveSplit("syncpay", admin)).toBeNull();
  });

  for (const p of PROVIDERS) {
    it(`${p}: USER_SPLIT_FEE_CENTS_<user>=0 → taxa zerada explicitamente, sem split`, async () => {
      const db = await testDb();
      const seller = await createProfile();
      await db.insert(platformConfig).values({ key: `USER_SPLIT_FEE_CENTS_${seller}`, value: "0" });
      expect(await resolveEffectiveSplit(p, seller)).toBeNull();
    });

    it(`${p}: <GW>_SPLIT_ENABLED=false desliga o split desse gateway mesmo com secret configurado`, async () => {
      process.env[`TEST_SECRET_${RECEIVER_ENV[p]}`] = "rc";
      try {
        const db = await testDb();
        const seller = await createProfile();
        await db.insert(platformConfig).values({ key: `${p.toUpperCase()}_SPLIT_ENABLED`, value: "false" });
        expect(await resolveEffectiveSplit(p, seller)).toBeNull();
      } finally { delete process.env[`TEST_SECRET_${RECEIVER_ENV[p]}`]; }
    });
  }

  it("<GW>_SPLIT_FEE_CENTS custom sobrescreve o valor do secret/default", async () => {
    process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID = "rc-secret";
    try {
      const db = await testDb();
      const seller = await createProfile();
      await db.insert(platformConfig).values({ key: "SYNCPAY_SPLIT_FEE_CENTS", value: "150" });
      expect(await resolveEffectiveSplit("syncpay", seller)).toEqual({ receiver: "rc-secret", cents: 150 });
    } finally { delete process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID; }
  });

  it("<GW>_SPLIT_USER_ID custom sobrescreve o recebedor do secret", async () => {
    process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID = "rc-secret";
    try {
      const db = await testDb();
      const seller = await createProfile();
      await db.insert(platformConfig).values({ key: "SYNCPAY_SPLIT_USER_ID", value: "rc-painel" });
      expect(await resolveEffectiveSplit("syncpay", seller)).toEqual({ receiver: "rc-painel", cents: 40 });
    } finally { delete process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID; }
  });

  it("USER_SPLIT_FEE_CENTS_<user> custom vale mesmo com <GW>_SPLIT_ENABLED=false (usuário tem precedência sobre gateway)", async () => {
    process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID = "rc-secret";
    try {
      const db = await testDb();
      const seller = await createProfile();
      await db.insert(platformConfig).values({ key: "SYNCPAY_SPLIT_ENABLED", value: "false" });
      await db.insert(platformConfig).values({ key: `USER_SPLIT_FEE_CENTS_${seller}`, value: "70" });
      expect(await resolveEffectiveSplit("syncpay", seller)).toEqual({ receiver: "rc-secret", cents: 70 });
    } finally { delete process.env.TEST_SECRET_SYNCPAY_SPLIT_USER_ID; }
  });
});

// ── Fluxo completo até o body do PIX (createPixWithFallback) ────────────────
describe("split efetivo — fluxo completo createPixWithFallback → body do PIX", () => {
  const PROVIDERS = ["syncpay", "buckpay", "nexuspag", "wiinpay"] as const;
  const URL_PART: Record<(typeof PROVIDERS)[number], string> = {
    syncpay: "cash-in", buckpay: "realtechdev", nexuspag: "nexuspag", wiinpay: "wiinpay",
  };

  for (const p of PROVIDERS) {
    it(`${p}: taxa zerada (USER_SPLIT_FEE_CENTS_<user>=0) → PIX sem split/splits no body`, async () => {
      const db = await testDb();
      const seller = await createProfile();
      await db.insert(platformConfig).values({ key: `USER_SPLIT_FEE_CENTS_${seller}`, value: "0" });
      const gwId = await createGateway({ userId: seller, provider: p });
      const gw = (await gwRepo.findByIdOwned(gwId, seller))!;

      await createPixWithFallback([gw], {
        amountCents: 1000, description: "P", webhookUrl: () => `https://wh/${p}`, ownerUserId: seller,
      });
      const call = getOtherCalls().filter((x) => x.url.includes(URL_PART[p])).at(-1);
      expect(call?.body?.split ?? call?.body?.splits).toBeUndefined();
    });
  }

  it("<GW>_SPLIT_ENABLED=false → PIX sem split", async () => {
    const db = await testDb();
    const seller = await createProfile();
    await db.insert(platformConfig).values({ key: "SYNCPAY_SPLIT_ENABLED", value: "false" });
    const gwId = await createGateway({ userId: seller, provider: "syncpay" });
    const gw = (await gwRepo.findByIdOwned(gwId, seller))!;

    await createPixWithFallback([gw], {
      amountCents: 1000, description: "P", webhookUrl: () => "https://wh/syncpay", ownerUserId: seller,
    });
    const call = getOtherCalls().filter((x) => x.url.includes("cash-in")).at(-1);
    expect(call?.body?.split).toBeUndefined();
  });

  it("<GW>_SPLIT_FEE_CENTS custom → PIX sai com o valor certo no body", async () => {
    process.env.TEST_SECRET_WIINPAY_SPLIT_USER_ID = "rc-secret";
    try {
      const db = await testDb();
      const seller = await createProfile();
      await db.insert(platformConfig).values({ key: "WIINPAY_SPLIT_FEE_CENTS", value: "150" });
      const gwId = await createGateway({ userId: seller, provider: "wiinpay" });
      const gw = (await gwRepo.findByIdOwned(gwId, seller))!;

      await createPixWithFallback([gw], {
        amountCents: 1000, description: "P", webhookUrl: () => "https://wh/wiinpay", ownerUserId: seller,
      });
      const call = getOtherCalls().filter((x) => x.url.includes("wiinpay")).at(-1);
      expect((call!.body!.split as any).value).toBe(1.5); // 150 centavos = R$ 1,50
      expect((call!.body!.split as any).user_id).toBe("rc-secret");
    } finally { delete process.env.TEST_SECRET_WIINPAY_SPLIT_USER_ID; }
  });
});

describe("createPixWithFallback — admin pula o split", () => {
  it("dono admin → PIX sem split; dono comum → com split", async () => {
    process.env.TEST_SECRET_WIINPAY_SPLIT_USER_ID = "rc";
    try {
      const db = await testDb();
      const adminId  = await createProfile();
      const commonId = await createProfile();
      await db.insert(userRoles).values({ userId: adminId, role: "admin" });

      const adminGwId  = await createGateway({ userId: adminId,  provider: "wiinpay" });
      const commonGwId = await createGateway({ userId: commonId, provider: "wiinpay" });
      const adminGw  = (await gwRepo.findByIdOwned(adminGwId,  adminId))!;
      const commonGw = (await gwRepo.findByIdOwned(commonGwId, commonId))!;

      await createPixWithFallback([adminGw], { amountCents: 600, description: "P", webhookUrl: () => "https://wh", ownerUserId: adminId });
      const adminCall = getOtherCalls().filter((x) => x.url.includes("wiinpay")).at(-1);
      expect(adminCall!.body!.split).toBeUndefined(); // admin → sem split

      await createPixWithFallback([commonGw], { amountCents: 600, description: "P", webhookUrl: () => "https://wh", ownerUserId: commonId });
      const commonCall = getOtherCalls().filter((x) => x.url.includes("wiinpay")).at(-1);
      expect((commonCall!.body!.split as any).value).toBe(0.4); // comum → com split
    } finally { delete process.env.TEST_SECRET_WIINPAY_SPLIT_USER_ID; }
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
    expect(await payRepo.isProcessed("e1", "buckpay", "paid")).toBe(false);
    await payRepo.markProcessed("e1", "buckpay", "paid");
    expect(await payRepo.isProcessed("e1", "buckpay", "paid")).toBe(true);
    await payRepo.markProcessed("e1", "buckpay", "paid"); // não duplica (onConflictDoNothing)
  });

  // Regressão: status faz parte da chave de idempotência — um webhook "pending"
  // processado antes NÃO pode bloquear um "paid" processado depois pro mesmo
  // externalId (era exatamente o bug que travava vendas da SyncPay em pendente).
  it("idempotência é por (externalId, provider, status) — pending não bloqueia paid", async () => {
    expect(await payRepo.isProcessed("e2", "buckpay", "pending")).toBe(false);
    await payRepo.markProcessed("e2", "buckpay", "pending");
    expect(await payRepo.isProcessed("e2", "buckpay", "pending")).toBe(true);
    expect(await payRepo.isProcessed("e2", "buckpay", "paid")).toBe(false);
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

  // Sem isso, payment_webhook_logs.processed ficava sempre false — a tela de
  // logs nunca marcava um webhook como "ok", nem os que confirmaram a venda.
  it("pagamento encontrado → log gravado com processed=true e amount preenchido", async () => {
    await seed("wh-log-ok");
    await processWebhookEvent({ externalId: "wh-log-ok", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, { any: "payload" });
    const db = await testDb();
    const [log] = await db.select().from(paymentWebhookLogs)
      .where(eq(paymentWebhookLogs.externalId, "wh-log-ok"));
    expect(log.processed).toBe(true);
    expect(log.amount).toBe(1990);
    expect(log.errorMessage).toBeNull();
  });

  it("idempotente: segundo evento não republica", async () => {
    const p = await seed("wh-idem");
    await processWebhookEvent({ externalId: "wh-idem", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, {});
    const countAfterFirst = published.length;
    await processWebhookEvent({ externalId: "wh-idem", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, {});
    expect(published.length).toBe(countAfterFirst);
    void p;
  });

  // Regressão do bug que travava vendas da SyncPay em pendente: o webhook de
  // criação (pending/waiting_for_approval) chega ANTES do de confirmação
  // (paid_out), mesmo externalId. O primeiro não pode "consumir" a
  // idempotência do segundo.
  it("pending seguido de paid (mesmo externalId) → venda é aprovada mesmo assim", async () => {
    const p = await seed("wh-pending-then-paid");
    await processWebhookEvent({ externalId: "wh-pending-then-paid", provider: "buckpay", status: "pending", amount: null, event: "pending" }, {});
    expect((await payRepo.findById(p.id))!.status).toBe("pending");

    await processWebhookEvent({ externalId: "wh-pending-then-paid", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, {});
    const got = await payRepo.findById(p.id);
    expect(got!.status).toBe("paid");
    expect(published.some((e) => e.topic === "payment-paid" && (e.event as { paymentId: string }).paymentId === p.id)).toBe(true);

    const db = await testDb();
    const logs = await db.select().from(paymentWebhookLogs)
      .where(eq(paymentWebhookLogs.externalId, "wh-pending-then-paid"));
    expect(logs).toHaveLength(2); // os dois webhooks foram logados, nenhum descartado
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

  // Investigar "venda não confirmou" começa por olhar o que o provedor mandou.
  // Enquanto o payload não reconhecido saía por um `return` mudo, "o provedor
  // nunca chamou" e "chamou e não entendemos" eram indistinguíveis.
  it("payload sem id reconhecível é registrado com o motivo, não descartado", async () => {
    const cru = { evento: "cobranca.paga", transacao: { referencia: "abc" } };
    await processWebhookEvent(
      { externalId: "", provider: "nexuspag", status: "pending", amount: null, event: "cobranca.paga" },
      cru,
    );
    const db = await testDb();
    const [log] = await db.select().from(paymentWebhookLogs)
      .where(eq(paymentWebhookLogs.provider, "nexuspag"));
    expect(log).toBeDefined();
    expect(log.payload).toEqual(cru);          // o corpo real fica disponível
    expect(log.errorMessage).toContain("sem identificador");
  });

  it("id extraído mas sem pagamento correspondente registra o motivo", async () => {
    await processWebhookEvent(
      { externalId: "id-de-outro-lugar", provider: "nexuspag", status: "paid", amount: 100, event: "paid" },
      { id: "id-de-outro-lugar" },
    );
    const db = await testDb();
    const [log] = await db.select().from(paymentWebhookLogs)
      .where(eq(paymentWebhookLogs.externalId, "id-de-outro-lugar"));
    expect(log.errorMessage).toContain("não corresponde a nenhum pagamento");
  });
});

// ── processWebhookEvent — receita e comissão seguem o MESMO split efetivo ───
// Regressão do bug: creditPlatformRevenue já checava se havia split real, mas
// accrueReferralCommission não — acumulava comissão mesmo quando o gateway
// tinha o split desligado no painel (<GW>_SPLIT_ENABLED=false), divergindo do
// que de fato foi cobrado no PIX.
describe("processWebhookEvent — receita e comissão seguem o split efetivo", () => {
  it("gateway com split desligado: venda é aprovada, mas SEM receita da plataforma e SEM comissão de indicação", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const bot = await createBot();
    const seller = bot.userId;
    await db.insert(referrals).values({ referredUserId: seller, referrerUserId: referrer });
    await db.insert(platformConfig).values({ key: "BUCKPAY_SPLIT_ENABLED", value: "false" });
    const gwId = await createGateway({ userId: seller, provider: "buckpay" });
    const p = await payRepo.create({
      userId: seller, botId: bot.id, gatewayId: gwId,
      amount: 1990, status: "pending", externalId: "wh-no-split", pixCode: "PIX", leadId: null,
    });

    await processWebhookEvent({ externalId: "wh-no-split", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, {});

    expect((await payRepo.findById(p.id))!.status).toBe("paid"); // venda aprovada normalmente

    const revenue = await db.select().from(paymentRevenueCredits).where(eq(paymentRevenueCredits.paymentId, p.id));
    expect(revenue).toHaveLength(0);

    const commissions = await db.select().from(referralCommissions).where(eq(referralCommissions.paymentId, p.id));
    expect(commissions).toHaveLength(0);
  });

  it("gateway com split ativo (secret configurado): venda paga credita receita E comissão de indicação", async () => {
    process.env.TEST_SECRET_BUCKPAY_SPLIT_EMAIL = "plataforma@orion.app";
    try {
      const db = await testDb();
      const referrer = await createProfile();
      const bot = await createBot();
      const seller = bot.userId;
      await db.insert(referrals).values({ referredUserId: seller, referrerUserId: referrer });
      const gwId = await createGateway({ userId: seller, provider: "buckpay" });
      const p = await payRepo.create({
        userId: seller, botId: bot.id, gatewayId: gwId,
        amount: 1990, status: "pending", externalId: "wh-with-split", pixCode: "PIX", leadId: null,
      });

      await processWebhookEvent({ externalId: "wh-with-split", provider: "buckpay", status: "paid", amount: 1990, event: "paid" }, {});

      const revenue = await db.select().from(paymentRevenueCredits).where(eq(paymentRevenueCredits.paymentId, p.id));
      expect(revenue).toHaveLength(1);
      expect(revenue[0].amount).toBe(40); // PLATFORM_SPLIT_CENTS fallback

      const commissions = await db.select().from(referralCommissions).where(eq(referralCommissions.paymentId, p.id));
      expect(commissions).toHaveLength(1);
      expect(commissions[0].baseFeeCents).toBe(40);
      expect(commissions[0].amountCents).toBe(8); // 20% de 40
    } finally { delete process.env.TEST_SECRET_BUCKPAY_SPLIT_EMAIL; }
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
