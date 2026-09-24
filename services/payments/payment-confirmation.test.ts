// Confirmação de pagamento (auditoria do backend, 24/09). Cada bloco cobre um
// achado com o cenário concreto de falha — todos falhavam antes da correção:
//   1. match pelo id externo sem escopo de dono → confirmava a venda errada
//   2. valor pago não conferido → "pago" com valor menor liberava o produto
//   3. split recalculado na confirmação → receita/comissão fora do que o PIX reteve
//   4. idempotência pelo candidates[0] → mesmo evento com outra ordem reprocessava
//   5. paymentPaid at-least-once sem guarda → entrega duplicada
//   6. sem máquina de estados → expirado/cancelado depois do pago rebaixava a venda
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createBot, createGateway, createProfile } from "../../test/helpers/seed.js";
import { published } from "../../test/stubs/encore-pubsub.js";
import { encrypt } from "../shared/crypto.js";
import {
  payments, paymentWebhookLogs, processedWebhooks, platformConfig,
  paymentRevenueCredits, referrals, referralCommissions, conversionEvents, trackingPixels,
} from "../shared/schema/index.js";
import { processWebhookEvent } from "./webhooks.js";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { GatewayDrizzleRepository } from "./infrastructure/gateway.drizzle.repository.js";
import { createPixWithFallback } from "./application/create-pix-with-fallback.js";
import {
  normalizeSyncpayWebhook, normalizeNexuspagWebhook, normalizeBuckpayWebhook, normalizeWiinpayWebhook,
} from "./application/gateway-clients.js";
import { ensureSchema } from "../shared/ensure-schema.js";
import { canTransition, checkPaidAmount } from "./domain/payment-status.js";
import type { PaymentSplitSnapshot } from "./domain/payment.entity.js";
import { deliverPaidOnce } from "../runner/application/deliver-paid-once.js";

const payRepo = new PaymentDrizzleRepository();
const gwRepo  = new GatewayDrizzleRepository();

async function seedPayment(opts: {
  externalId: string;
  provider?: string;
  amount?: number;
  status?: string;
  userId?: string;
  botId?: string;
  gatewayId?: string;
  splitSnapshot?: PaymentSplitSnapshot | null;
}) {
  const provider = opts.provider ?? "buckpay";
  const bot = opts.botId && opts.userId ? { id: opts.botId, userId: opts.userId } : await createBot();
  const gatewayId = opts.gatewayId ?? await createGateway({ userId: bot.userId, provider });
  return payRepo.create({
    userId: bot.userId, botId: bot.id, gatewayId,
    amount: opts.amount ?? 1990, status: opts.status ?? "pending",
    externalId: opts.externalId, pixCode: "PIX", leadId: null,
    splitSnapshot: opts.splitSnapshot,
  });
}

function paidPublishes(paymentId: string): number {
  return published.filter((e) => e.topic === "payment-paid" && (e.event as { paymentId: string }).paymentId === paymentId).length;
}

async function logsFor(paymentId: string) {
  const db = await testDb();
  return db.select().from(paymentWebhookLogs).where(eq(paymentWebhookLogs.matchedPaymentId, paymentId));
}

// Evento de pago com valor BRUTO declarado (como os normalizadores fazem) — só
// o bruto pode recusar uma confirmação por valor.
const paid = (externalId: string, amount: number | null = 1990, extra: Record<string, unknown> = {}) =>
  ({ externalId, provider: "buckpay" as const, status: "paid" as const, amount, grossAmount: amount, event: "paid", ...extra });

// ── 1. Match escopado ───────────────────────────────────────────────────────
describe("confirmação — match do pagamento escopado", () => {
  it("id externo colidindo entre dois vendedores do mesmo provider → ambíguo, nenhum é confirmado", async () => {
    const a = await seedPayment({ externalId: "colide-1" });
    const b = await seedPayment({ externalId: "colide-1" });

    expect(await processWebhookEvent(paid("colide-1"), {})).toBe("ambiguous");

    expect((await payRepo.findById(a.id))!.status).toBe("pending");
    expect((await payRepo.findById(b.id))!.status).toBe("pending");
    expect(published.filter((e) => e.topic === "payment-paid")).toHaveLength(0);
    const db = await testDb();
    const [log] = await db.select().from(paymentWebhookLogs).where(eq(paymentWebhookLogs.externalId, "colide-1"));
    expect(log.errorMessage).toContain("ambíguo");
  });

  it("candidatos diferentes do mesmo payload batendo em cobranças diferentes → ambíguo", async () => {
    const a = await seedPayment({ externalId: "cand-a" });
    const b = await seedPayment({ externalId: "cand-b" });
    const outcome = await processWebhookEvent(paid("cand-a", 1990, { externalIdCandidates: ["cand-a", "cand-b"] }), {});
    expect(outcome).toBe("ambiguous");
    expect((await payRepo.findById(a.id))!.status).toBe("pending");
    expect((await payRepo.findById(b.id))!.status).toBe("pending");
  });

  it("cobrança cujo gateway é de OUTRO usuário não casa (dado inconsistente não vira venda)", async () => {
    const bot = await createBot();
    const stranger = await createProfile();
    const foreignGw = await createGateway({ userId: stranger, provider: "buckpay" });
    const p = await seedPayment({ externalId: "gw-alheio", userId: bot.userId, botId: bot.id, gatewayId: foreignGw });

    expect(await processWebhookEvent(paid("gw-alheio"), {})).toBe("not_found");
    expect((await payRepo.findById(p.id))!.status).toBe("pending");
  });

  it("webhook que chega ANTES da cobrança ser gravada não consome a idempotência: a reentrega confirma", async () => {
    expect(await processWebhookEvent(paid("antes-do-insert"), {})).toBe("not_found");
    const p = await seedPayment({ externalId: "antes-do-insert" });
    expect(await processWebhookEvent(paid("antes-do-insert"), {})).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
  });
});

// ── 2. Valor pago ───────────────────────────────────────────────────────────
describe("confirmação — valor pago precisa bater com o cobrado", () => {
  it("valor BRUTO menor que o cobrado → não confirma, registra a falha e não consome a idempotência", async () => {
    const p = await seedPayment({ externalId: "valor-menor", amount: 1990 });

    expect(await processWebhookEvent(paid("valor-menor", 100), {})).toBe("amount_mismatch");

    const got = await payRepo.findById(p.id);
    expect(got!.status).toBe("pending");
    expect(got!.paidAt).toBeNull();
    expect(paidPublishes(p.id)).toBe(0);
    const [log] = await logsFor(p.id);
    expect(log.processed).toBe(false);
    expect(log.errorMessage).toContain("menor que o cobrado");
    const db = await testDb();
    expect(await db.select().from(processedWebhooks).where(eq(processedWebhooks.externalId, "valor-menor"))).toHaveLength(0);

    // Reentrega com o valor certo (ou conciliação) ainda confirma.
    expect(await processWebhookEvent(paid("valor-menor", 1990), {})).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
  });

  it("diferença de 1 centavo (arredondamento reais→centavos) é tolerada; bruto maior também confirma", async () => {
    const a = await seedPayment({ externalId: "um-centavo", amount: 1990 });
    const b = await seedPayment({ externalId: "a-maior", amount: 1990 });
    expect(await processWebhookEvent(paid("um-centavo", 1989), {})).toBe("confirmed");
    expect(await processWebhookEvent(paid("a-maior", 2090), {})).toBe("confirmed");
    expect((await payRepo.findById(a.id))!.status).toBe("paid");
    expect((await payRepo.findById(b.id))!.status).toBe("paid");
    expect((await logsFor(a.id))[0].errorMessage).toBeNull(); // conferido, sem observação
  });

  it("webhook SEM valor legível → confirma e registra amount_unknown (não recusa venda legítima)", async () => {
    const p = await seedPayment({ externalId: "sem-valor" });
    expect(await processWebhookEvent(paid("sem-valor", null), {})).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    const [log] = await logsFor(p.id);
    expect(log.processed).toBe(true);
    expect(log.errorMessage).toContain("amount_unknown");
  });

  it("checkPaidAmount: regra isolada", () => {
    expect(checkPaidAmount(1990, { grossAmount: 1990 })).toEqual({ ok: true, verified: true });
    expect(checkPaidAmount(1990, { grossAmount: 1989 }).ok).toBe(true);
    expect(checkPaidAmount(1990, { grossAmount: 1988 }).ok).toBe(false);
    expect(checkPaidAmount(1990, { grossAmount: null, amount: 100, amountIsNet: true }))
      .toMatchObject({ ok: true, verified: false, code: "amount_is_net" });
    expect(checkPaidAmount(1990, { amount: 1990 }))
      .toMatchObject({ ok: true, verified: false, code: "amount_not_gross" });
    expect(checkPaidAmount(1990, { grossAmount: null, amount: null }))
      .toMatchObject({ ok: true, verified: false, code: "amount_unknown" });
    expect(checkPaidAmount(1990, { grossAmount: Number.NaN, amount: null }))
      .toMatchObject({ ok: true, verified: false, code: "amount_unknown" });
  });
});

// Formatos REAIS de payload de pago (produção, 2026-09-24), anonimizados: só
// os campos de valor + ids fictícios. Com a regra anterior (recusar sem bruto
// ou abaixo do cobrado lendo o campo errado) vários destes eram recusados.
describe("confirmação — formatos reais de payload de pago", () => {
  it("BuckPay: bruto em data.total_amount (CENTAVOS), net_amount líquido → confirma conferido", async () => {
    const p = await seedPayment({ externalId: "bk-real-1", provider: "buckpay", amount: 600 });
    const body = {
      event: "transaction.processed",
      data: { id: "bk-real-1", status: "paid", total_amount: 600, net_amount: 401, offer: { discount_price: 600 } },
    };
    const event = normalizeBuckpayWebhook(body);
    expect(event).toMatchObject({ grossAmount: 600, amount: 600, amountIsNet: false });
    expect(await processWebhookEvent(event, body)).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    expect((await logsFor(p.id))[0].errorMessage).toBeNull();
  });

  it("BuckPay sem `offer`: total_amount=600, net_amount=371 → confirma", async () => {
    const p = await seedPayment({ externalId: "bk-real-2", provider: "buckpay", amount: 600 });
    const body = { event: "transaction.processed", data: { id: "bk-real-2", status: "paid", total_amount: 600, net_amount: 371 } };
    expect(await processWebhookEvent(normalizeBuckpayWebhook(body), body)).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
  });

  it("NexusPag: bruto `amount` em REAIS, net_amount/fee → confirma conferido", async () => {
    const p = await seedPayment({ externalId: "nx-real-1", provider: "nexuspag", amount: 300 });
    const body = { transaction_id: "nx-real-1", status: "paid", event: "payment.confirmed", amount: 3, net_amount: 2.35, fee: 0.65 };
    const event = normalizeNexuspagWebhook(body);
    expect(event).toMatchObject({ grossAmount: 300, amountIsNet: false });
    expect(await processWebhookEvent(event, body)).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    expect((await logsFor(p.id))[0].errorMessage).toBeNull();
  });

  it("SyncPay: bruto data.amount em REAIS, final_amount líquido → confirma (antes era 'abaixo do cobrado')", async () => {
    const p = await seedPayment({ externalId: "sp-real-1", provider: "syncpay", amount: 300 });
    const body = { data: { identifier: "sp-real-1", status: "PAID_OUT", amount: 3, final_amount: 2.65 } };
    const event = normalizeSyncpayWebhook(body);
    expect(event).toMatchObject({ grossAmount: 300, amount: 265 });
    expect(await processWebhookEvent(event, body)).toBe("confirmed");
    const got = await payRepo.findById(p.id);
    expect(got!.status).toBe("paid");
    expect(got!.finalAmount).toBe(265); // final_amount segue gravado como antes
  });

  it("SyncPay só com data.amount (caso que o log gravou sem valor) → confirma conferido", async () => {
    const p = await seedPayment({ externalId: "sp-real-2", provider: "syncpay", amount: 690 });
    const body = { data: { identifier: "sp-real-2", status: "PAID_OUT", amount: 6.9 } };
    expect(await processWebhookEvent(normalizeSyncpayWebhook(body), body)).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
  });

  it("WiinPay: só `value` LÍQUIDO (abaixo do cobrado) → confirma, marca amountIsNet e registra no log", async () => {
    const p = await seedPayment({ externalId: "wp-real-1", provider: "wiinpay", amount: 490 });
    const body = { data: { paymentId: "wp-real-1", status: "PAID", value: 4.65 } };
    const event = normalizeWiinpayWebhook(body);
    expect(event).toMatchObject({ grossAmount: null, amount: 465, amountIsNet: true });
    expect(await processWebhookEvent(event, body)).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    const [log] = await logsFor(p.id);
    expect(log.processed).toBe(true);
    expect(log.errorMessage).toContain("amount_is_net");
    expect(log.errorMessage).toContain("líquido");
  });

  it("valores como STRING numérica também são lidos (hipótese dos logs com valor nulo)", () => {
    expect(normalizeSyncpayWebhook({ data: { identifier: "s", status: "PAID_OUT", amount: "6.90" } }).grossAmount).toBe(690);
    expect(normalizeBuckpayWebhook({ data: { id: "b", status: "paid", total_amount: "600" } }).grossAmount).toBe(600);
    expect(normalizeNexuspagWebhook({ transaction_id: "n", status: "paid", amount: "3" }).grossAmount).toBe(300);
    expect(normalizeWiinpayWebhook({ data: { paymentId: "w", status: "PAID", value: "4.65" } }).amount).toBe(465);
    expect(normalizeWiinpayWebhook({ data: { paymentId: "w", status: "PAID", value: "abc" } }).amount).toBeNull();
  });

  it("bruto REALMENTE abaixo do cobrado (BuckPay total_amount=300, cobrado 600) → recusa", async () => {
    const p = await seedPayment({ externalId: "bk-abaixo", provider: "buckpay", amount: 600 });
    const body = { event: "transaction.processed", data: { id: "bk-abaixo", status: "paid", total_amount: 300, net_amount: 200 } };
    expect(await processWebhookEvent(normalizeBuckpayWebhook(body), body)).toBe("amount_mismatch");
    expect((await payRepo.findById(p.id))!.status).toBe("pending");
    expect(paidPublishes(p.id)).toBe(0);
    expect((await logsFor(p.id))[0].errorMessage).toContain("valor bruto pago");
  });
});

// ── 3. Split: snapshot da criação ───────────────────────────────────────────
describe("confirmação — usa o split gravado na criação da cobrança", () => {
  it("createPixWithFallback devolve o split que foi para o gateway", async () => {
    process.env.TEST_SECRET_BUCKPAY_SPLIT_EMAIL = "plataforma@orion.app";
    try {
      const bot = await createBot();
      const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
      const gw = (await gwRepo.findById(gwId))!;
      const res = await createPixWithFallback([gw], {
        amountCents: 1990, description: "P", webhookUrl: () => "https://wh", ownerUserId: bot.userId,
      });
      expect(res!.splitSnapshot).toEqual({ receiver: "plataforma@orion.app", cents: 40, feeCents: 40 });
    } finally { delete process.env.TEST_SECRET_BUCKPAY_SPLIT_EMAIL; }

    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const res = await createPixWithFallback([(await gwRepo.findById(gwId))!], {
      amountCents: 1990, description: "P", webhookUrl: () => "https://wh", ownerUserId: bot.userId,
    });
    expect(res!.splitSnapshot).toEqual({ receiver: null, cents: 0, feeCents: 0 });
  });

  it("split DESLIGADO no painel depois do PIX: receita e comissão seguem o que o PIX reteve", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const bot = await createBot();
    await db.insert(referrals).values({ referredUserId: bot.userId, referrerUserId: referrer });
    const p = await seedPayment({
      externalId: "snap-com-split", userId: bot.userId, botId: bot.id,
      splitSnapshot: { receiver: "plataforma@orion.app", cents: 40, feeCents: 40 },
    });
    // Admin desliga o split do gateway ENTRE a criação do PIX e o pagamento.
    await db.insert(platformConfig).values({ key: "BUCKPAY_SPLIT_ENABLED", value: "false" });

    expect(await processWebhookEvent(paid("snap-com-split"), {})).toBe("confirmed");

    const revenue = await db.select().from(paymentRevenueCredits).where(eq(paymentRevenueCredits.paymentId, p.id));
    expect(revenue.map((r) => r.amount)).toEqual([40]);
    const commissions = await db.select().from(referralCommissions).where(eq(referralCommissions.paymentId, p.id));
    expect(commissions).toHaveLength(1);
    expect(commissions[0].baseFeeCents).toBe(40);
  });

  it("PIX criado SEM split e split ligado depois: nada de receita nem comissão", async () => {
    process.env.TEST_SECRET_BUCKPAY_SPLIT_EMAIL = "plataforma@orion.app";
    try {
      const db = await testDb();
      const referrer = await createProfile();
      const bot = await createBot();
      await db.insert(referrals).values({ referredUserId: bot.userId, referrerUserId: referrer });
      const p = await seedPayment({
        externalId: "snap-sem-split", userId: bot.userId, botId: bot.id,
        splitSnapshot: { receiver: null, cents: 0, feeCents: 0 },
      });

      expect(await processWebhookEvent(paid("snap-sem-split"), {})).toBe("confirmed");

      expect(await db.select().from(paymentRevenueCredits).where(eq(paymentRevenueCredits.paymentId, p.id))).toHaveLength(0);
      expect(await db.select().from(referralCommissions).where(eq(referralCommissions.paymentId, p.id))).toHaveLength(0);
    } finally { delete process.env.TEST_SECRET_BUCKPAY_SPLIT_EMAIL; }
  });
});

// ── 4 e 5. Idempotência e entrega exatamente uma vez ────────────────────────
describe("confirmação — idempotência determinística e efeitos uma vez só", () => {
  async function addPixel(botId: string): Promise<void> {
    const db = await testDb();
    await db.insert(trackingPixels).values({
      botId, provider: "tiktok", pixelId: "px_tiktok", accessToken: encrypt("tok"), isActive: true,
    });
  }

  it("mesmo evento com os candidatos em outra ordem não reprocessa (antes a chave era candidates[0])", async () => {
    const p = await seedPayment({ externalId: "canon-id" });
    await addPixel(p.botId);

    const first  = await processWebhookEvent(paid("lixo-1", 1990, { externalIdCandidates: ["lixo-1", "canon-id"] }), {});
    const second = await processWebhookEvent(paid("canon-id", 1990, { externalIdCandidates: ["canon-id", "lixo-1"] }), {});
    const third  = await processWebhookEvent(paid("lixo-2", 1990, { externalIdCandidates: ["lixo-2", "canon-id"] }), {});

    expect([first, second, third]).toEqual(["confirmed", "duplicate", "duplicate"]);
    expect(paidPublishes(p.id)).toBe(1);
    const db = await testDb();
    expect(await db.select().from(conversionEvents).where(eq(conversionEvents.paymentId, p.id))).toHaveLength(1);
    expect(await logsFor(p.id)).toHaveLength(1);
  });

  it("dois webhooks de pago CONCORRENTES: só um confirma; pixel/push uma vez e entrega uma vez", async () => {
    const p = await seedPayment({ externalId: "concorrente" });
    await addPixel(p.botId);

    const outcomes = await Promise.all([
      processWebhookEvent(paid("concorrente"), {}),
      processWebhookEvent(paid("concorrente"), {}),
    ]);

    expect(outcomes.filter((o) => o === "confirmed")).toHaveLength(1);
    const db = await testDb();
    expect(await db.select().from(conversionEvents).where(eq(conversionEvents.paymentId, p.id))).toHaveLength(1);

    // O evento pode ter sido publicado mais de uma vez (at-least-once); a
    // entrega reivindica e roda uma vez só.
    let deliveries = 0;
    for (const ev of published.filter((e) => e.topic === "payment-paid")) {
      await deliverPaidOnce((ev.event as { paymentId: string }).paymentId, async () => { deliveries++; });
    }
    expect(deliveries).toBe(1);
  });

  it("deliverPaidOnce: a mesma mensagem reentregue não entrega de novo", async () => {
    const p = await seedPayment({ externalId: "entrega-1" });
    await processWebhookEvent(paid("entrega-1"), {});

    let deliveries = 0;
    const deliver = async () => { deliveries++; };
    expect(await deliverPaidOnce(p.id, deliver)).toBe("delivered");
    expect(await deliverPaidOnce(p.id, deliver)).toBe("skipped");
    expect(await deliverPaidOnce(p.id, deliver)).toBe("skipped");
    expect(deliveries).toBe(1);
    expect((await payRepo.findById(p.id))!.deliveredAt).toBeInstanceOf(Date);
  });

  it("deliverPaidOnce: pagamento que não está pago não é entregue", async () => {
    const p = await seedPayment({ externalId: "nao-pago" });
    let deliveries = 0;
    expect(await deliverPaidOnce(p.id, async () => { deliveries++; })).toBe("skipped");
    expect(deliveries).toBe(0);
  });

  it("deliverPaidOnce: falha na entrega fica reivindicada (não reentrega às cegas); reivindicação velha é retomada", async () => {
    const p = await seedPayment({ externalId: "entrega-falha" });
    await processWebhookEvent(paid("entrega-falha"), {});

    expect(await deliverPaidOnce(p.id, async () => { throw new Error("telegram fora"); })).toBe("failed");
    const afterFail = await payRepo.findById(p.id);
    expect(afterFail!.deliveredAt).toBeNull();
    expect(afterFail!.deliveryClaimedAt).toBeInstanceOf(Date);

    let deliveries = 0;
    expect(await deliverPaidOnce(p.id, async () => { deliveries++; })).toBe("skipped");

    // Processo morreu no meio: reivindicação com mais de 10 min pode ser retomada.
    const db = await testDb();
    await db.update(payments).set({ deliveryClaimedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(payments.id, p.id));
    expect(await deliverPaidOnce(p.id, async () => { deliveries++; })).toBe("delivered");
    expect(deliveries).toBe(1);
  });

  it("pago repetido para venda já paga e sem entrega reivindicada republica o evento (recuperação), sem push/pixel", async () => {
    const p = await seedPayment({ externalId: "recupera" });
    await addPixel(p.botId);
    await processWebhookEvent(paid("recupera"), {});
    // Simula a confirmação anterior ter caído antes da idempotência ser gravada.
    const db = await testDb();
    await db.delete(processedWebhooks);
    published.length = 0;

    expect(await processWebhookEvent(paid("recupera"), {})).toBe("already_paid");
    expect(paidPublishes(p.id)).toBe(1);
    expect(await db.select().from(conversionEvents).where(eq(conversionEvents.paymentId, p.id))).toHaveLength(1);

    // Depois que a entrega foi reivindicada, nem republica mais.
    await deliverPaidOnce(p.id, async () => {});
    await db.delete(processedWebhooks);
    published.length = 0;
    expect(await processWebhookEvent(paid("recupera"), {})).toBe("already_paid");
    expect(paidPublishes(p.id)).toBe(0);
  });
});

// ── 6. Máquina de estados ───────────────────────────────────────────────────
describe("confirmação — máquina de estados", () => {
  it("expirado depois do pago é registrado e ignorado: a venda continua paga", async () => {
    const p = await seedPayment({ externalId: "pago-depois-expira" });
    await processWebhookEvent(paid("pago-depois-expira"), {});

    const outcome = await processWebhookEvent(
      { externalId: "pago-depois-expira", provider: "buckpay", status: "expired", amount: null, event: "expired" }, {},
    );
    expect(outcome).toBe("invalid_transition");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    const logs = await logsFor(p.id);
    expect(logs.some((l) => (l.errorMessage ?? "").includes("transição inválida: paid → expired"))).toBe(true);
  });

  it("cancelado/estorno depois do pago não rebaixa a venda", async () => {
    const p = await seedPayment({ externalId: "pago-depois-cancela" });
    await processWebhookEvent(paid("pago-depois-cancela"), {});
    await processWebhookEvent(
      { externalId: "pago-depois-cancela", provider: "buckpay", status: "cancelled", amount: null, event: "refunded" }, {},
    );
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
  });

  it("pago depois de cancelado não entrega: registrado para conferência manual", async () => {
    const p = await seedPayment({ externalId: "cancela-depois-paga" });
    await processWebhookEvent(
      { externalId: "cancela-depois-paga", provider: "buckpay", status: "cancelled", amount: null, event: "cancelled" }, {},
    );
    expect(await processWebhookEvent(paid("cancela-depois-paga"), {})).toBe("invalid_transition");
    expect((await payRepo.findById(p.id))!.status).toBe("cancelled");
    expect(paidPublishes(p.id)).toBe(0);
    const logs = await logsFor(p.id);
    expect(logs.some((l) => (l.errorMessage ?? "").includes("cancelled → paid"))).toBe(true);
  });

  it("pago depois de EXPIRADO confirma: o runner expira localmente e o PIX segue pagável no gateway", async () => {
    const p = await seedPayment({ externalId: "expira-depois-paga", status: "expired" });
    expect(await processWebhookEvent(paid("expira-depois-paga"), {})).toBe("confirmed");
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    expect(paidPublishes(p.id)).toBe(1);
  });

  it("transitionStatus é condicional ao status de origem", async () => {
    const p = await seedPayment({ externalId: "trans" });
    expect(await payRepo.transitionStatus(p.id, "paid", { finalAmount: 1990 })).not.toBeNull();
    expect(await payRepo.transitionStatus(p.id, "paid")).toBeNull();
    expect(await payRepo.transitionStatus(p.id, "cancelled")).toBeNull();
    expect(await payRepo.transitionStatus(p.id, "expired")).toBeNull();
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
  });

  it("canTransition: tabela de transições", () => {
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("expired", "paid")).toBe(true);
    expect(canTransition("cancelled", "paid")).toBe(false);
    expect(canTransition("paid", "cancelled")).toBe(false);
    expect(canTransition("paid", "expired")).toBe(false);
    expect(canTransition("expired", "expired")).toBe(false);
    expect(canTransition("pending", "pending")).toBe(false);
  });
});

// ── Vendas pagas ANTES da 0021 (revisão do PR #58) ──────────────────────────
// delivery_claimed_at/delivered_at nasciam NULL pra toda venda já paga. Como a
// chave de idempotência mudou, um pago reentregue (ou a conciliação) pra venda
// legada passava pela deduplicação, caía em already_paid, republicava
// paymentPaid e claimDelivery aceitava → reentregava produto/VIP antigo.
describe("vendas pagas antes da 0021 — backfill da entrega", () => {
  it("venda legada paga + pago reentregue depois do deploy → não republica nem reentrega", async () => {
    const db = await testDb();
    const legacy = await seedPayment({ externalId: "legado-pago", splitSnapshot: null });
    const paidAt = new Date("2026-05-01T12:00:00Z");
    await db.update(payments).set({ status: "paid", paidAt }).where(eq(payments.id, legacy.id));
    const stillPending = await seedPayment({ externalId: "legado-pendente" });

    // Simula o banco de produção ANTES da 0021: a coluna ainda não existe.
    await db.execute(sql`ALTER TABLE "payments" DROP COLUMN "delivered_at"`);
    await db.execute(sql`UPDATE "payments" SET "delivery_claimed_at" = NULL`);
    expect(await ensureSchema()).toEqual([]);

    const backfilled = await payRepo.findById(legacy.id);
    expect(backfilled!.deliveredAt?.toISOString()).toBe(paidAt.toISOString());
    expect(backfilled!.deliveryClaimedAt?.toISOString()).toBe(paidAt.toISOString());
    expect((await payRepo.findById(stillPending.id))!.deliveredAt).toBeNull();

    expect(await processWebhookEvent(paid("legado-pago"), {})).toBe("already_paid");
    expect(paidPublishes(legacy.id)).toBe(0);
    let deliveries = 0;
    expect(await deliverPaidOnce(legacy.id, async () => { deliveries++; })).toBe("skipped");
    expect(deliveries).toBe(0);
  });

  it("o backfill roda uma vez só: reboot não marca como entregue venda paga depois do deploy", async () => {
    const p = await seedPayment({ externalId: "pago-pos-deploy" });
    await processWebhookEvent(paid("pago-pos-deploy"), {}); // pago, entrega ainda a caminho

    expect(await ensureSchema()).toEqual([]); // restart do serviço

    const got = await payRepo.findById(p.id);
    expect(got!.deliveredAt).toBeNull();
    expect(got!.deliveryClaimedAt).toBeNull();
    let deliveries = 0;
    expect(await deliverPaidOnce(p.id, async () => { deliveries++; })).toBe("delivered");
    expect(deliveries).toBe(1);
  });
});

// ── Valor só líquido (NexusPag net_amount) ──────────────────────────────────
describe("valor só líquido no payload", () => {
  it("NexusPag só com net_amount: confirma, marca amountIsNet e o log diz que não conferiu", async () => {
    const p = await seedPayment({ externalId: "nx-liquido", provider: "nexuspag", amount: 1990 });
    const body = { transaction_id: "nx-liquido", status: "paid", net_amount: 18.5 };
    const event = normalizeNexuspagWebhook(body);
    expect(event).toMatchObject({ grossAmount: null, amount: 1850, amountIsNet: true });
    expect(await processWebhookEvent(event, body)).toBe("confirmed");
    const [log] = await logsFor(p.id);
    expect(log.errorMessage).toContain("amount_is_net");
  });
});
