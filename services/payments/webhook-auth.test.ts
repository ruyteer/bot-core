import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  normalizeSyncpayWebhook, normalizeBuckpayWebhook,
  normalizeNexuspagWebhook, normalizeWiinpayWebhook,
  type NormalizedWebhookEvent,
} from "./application/gateway-clients.js";
import { fetchChargeStatus, __resetSyncpayStatusTokenCacheForTests } from "./application/gateway-status.js";
import { _resetWebhookRateLimiterForTests, WEBHOOK_PAYMENT_CHECK_LIMIT } from "./application/webhook-rate-limiter.js";
import { createPixWithFallback } from "./application/create-pix-with-fallback.js";
import { handleGatewayWebhook } from "./webhooks.js";
import { reconcilePendingPayments } from "./reconcile.js";
import { PaymentDrizzleRepository } from "./infrastructure/payment.drizzle.repository.js";
import { GatewayDrizzleRepository } from "./infrastructure/gateway.drizzle.repository.js";
import type { Provider } from "./domain/gateway.entity.js";
import { testDb } from "../../test/helpers/db.js";
import { createBot, createGateway } from "../../test/helpers/seed.js";
import { published } from "../../test/stubs/encore-pubsub.js";
import { payments, paymentWebhookLogs, paymentReconciliation } from "../shared/schema/index.js";

const payRepo = new PaymentDrizzleRepository();
const gwRepo  = new GatewayDrizzleRepository();

// ── fetch: rotas de CONSULTA de status por teste, por cima do mock global ────
type Route = (url: string, init?: RequestInit) => Response | undefined;
let routes: Route[] = [];
let gatewayCalls: string[] = [];
let baseFetch: typeof globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Responde a consulta de status (GET) de uma cobrança num gateway.
function gatewayStatus(provider: Provider, lookupId: string, body: unknown, status = 200): void {
  const path = {
    syncpay:  `/api/partner/v1/transaction/${lookupId}`,
    buckpay:  `/v1/transactions/external_id/${lookupId}`,
    nexuspag: `/api/pix/${lookupId}`,
    wiinpay:  `/payment/list/${lookupId}`,
  }[provider];
  routes.push((url, init) =>
    (init?.method ?? "GET") === "GET" && url.endsWith(path) ? json(body, status) : undefined);
}

beforeEach(() => {
  _resetWebhookRateLimiterForTests();
  __resetSyncpayStatusTokenCacheForTests();
  routes = [];
  gatewayCalls = [];
  baseFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if ((init?.method ?? "GET") === "GET" && /syncpay|realtechdev|nexuspag|wiinpay/.test(url)) gatewayCalls.push(url);
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    // Consulta de status sem rota definida = cobrança inexistente.
    if ((init?.method ?? "GET") === "GET" && /syncpay|realtechdev|nexuspag|wiinpay/.test(url)) return json({ message: "not found" }, 404);
    return baseFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = baseFetch;
  vi.restoreAllMocks();
});

// ── req/resp falsos do api.raw ──────────────────────────────────────────────
function fakeReq(body: unknown) {
  const buf = Buffer.from(JSON.stringify(body));
  return {
    socket: { remoteAddress: "203.0.113.9" },
    async *[Symbol.asyncIterator]() { yield buf; },
  };
}

function fakeResp() {
  const calls: string[] = [];
  return {
    calls,
    writeHead(status: number) { calls.push(`head:${status}`); },
    end(body?: string) { calls.push(`end:${body ?? ""}`); },
  };
}

const NORMALIZERS: Record<Provider, (b: Record<string, unknown>) => NormalizedWebhookEvent> = {
  syncpay:  normalizeSyncpayWebhook,
  buckpay:  normalizeBuckpayWebhook,
  nexuspag: normalizeNexuspagWebhook,
  wiinpay:  normalizeWiinpayWebhook,
};

async function postWebhook(provider: Provider, body: unknown) {
  const resp = fakeResp();
  await handleGatewayWebhook(provider, NORMALIZERS[provider], fakeReq(body), resp);
  return resp;
}

async function seedPayment(provider: Provider, externalId: string, opts: { amount?: number; status?: string; ageMs?: number } = {}) {
  const bot  = await createBot();
  const gwId = await createGateway({ userId: bot.userId, provider });
  const p = await payRepo.create({
    userId: bot.userId, botId: bot.id, gatewayId: gwId,
    amount: opts.amount ?? 1990, status: opts.status ?? "pending", externalId, pixCode: "PIX", leadId: null,
  });
  if (opts.ageMs !== undefined) {
    const db = await testDb();
    await db.update(payments).set({ createdAt: new Date(Date.now() - opts.ageMs) }).where(eq(payments.id, p.id));
  }
  return p;
}

function paidPublishes(paymentId: string): number {
  return published.filter((e) => e.topic === "payment-paid" && (e.event as { paymentId: string }).paymentId === paymentId).length;
}

// ── 1. Autenticação: o payload não confirma nada sozinho ────────────────────
describe("webhook de pagamento — confirmação ativa no gateway", () => {
  it("webhook forjado com status paid, mas gateway diz pendente → venda NÃO é aprovada", async () => {
    const p = await seedPayment("wiinpay", "wp-forged");
    gatewayStatus("wiinpay", "wp-forged", { data: { paymentId: "wp-forged", status: "PENDING", value: 19.9 } });

    const resp = await postWebhook("wiinpay", { data: { paymentId: "wp-forged", status: "PAID", value: 19.9 } });

    expect(resp.calls).toEqual(["head:200", "end:ok"]);
    expect((await payRepo.findById(p.id))!.status).toBe("pending");
    expect(paidPublishes(p.id)).toBe(0);
    const db = await testDb();
    const [log] = await db.select().from(paymentWebhookLogs).where(eq(paymentWebhookLogs.matchedPaymentId, p.id));
    expect(log.processed).toBe(false);
    expect(log.errorMessage).toMatch(/gateway diz "PENDING"/);
  });

  it("webhook confirmado pelo gateway → aprova com o valor que o GATEWAY informou, não o do payload", async () => {
    const p = await seedPayment("syncpay", "sp-ok");
    gatewayStatus("syncpay", "sp-ok", { data: { reference_id: "r1", status: "completed", amount: 19.9 } });

    // Payload mente o valor: só o gateway vale.
    const resp = await postWebhook("syncpay", { data: { identifier: "sp-ok", status: "PAID_OUT", amount: 0.01 } });

    expect(resp.calls).toEqual(["head:200", "end:ok"]);
    const got = await payRepo.findById(p.id);
    expect(got!.status).toBe("paid");
    expect(got!.finalAmount).toBe(1990);
    expect(paidPublishes(p.id)).toBe(1);
    // Consultou a cobrança certa, com a credencial do dono.
    expect(gatewayCalls.some((u) => u.endsWith("/api/partner/v1/transaction/sp-ok"))).toBe(true);
  });

  it("webhook diz pendente mas gateway já diz pago → aprova (vale o gateway)", async () => {
    const p = await seedPayment("nexuspag", "nx-late");
    gatewayStatus("nexuspag", "nx-late", { id: "nx-late", status: "paid", amount: 19.9 });

    await postWebhook("nexuspag", { transaction_id: "nx-late", status: "pending" });

    expect((await payRepo.findById(p.id))!.status).toBe("paid");
  });

  it("gateway fora do ar na consulta → responde 503 (gateway reenvia) e não aprova", async () => {
    const p = await seedPayment("nexuspag", "nx-down");
    gatewayStatus("nexuspag", "nx-down", { message: "boom" }, 502);

    const resp = await postWebhook("nexuspag", { transaction_id: "nx-down", status: "paid", event: "payment.confirmed" });

    expect(resp.calls).toEqual(["head:503", "end:retry"]);
    expect((await payRepo.findById(p.id))!.status).toBe("pending");
  });

  it("cobrança inexistente no gateway (404) → ignorado com log, sem aprovar", async () => {
    const p = await seedPayment("wiinpay", "wp-ghost");

    const resp = await postWebhook("wiinpay", { data: { paymentId: "wp-ghost", status: "PAID" } });

    expect(resp.calls).toEqual(["head:200", "end:ok"]);
    expect((await payRepo.findById(p.id))!.status).toBe("pending");
    const db = await testDb();
    const [log] = await db.select().from(paymentWebhookLogs).where(eq(paymentWebhookLogs.matchedPaymentId, p.id));
    expect(log.errorMessage).toMatch(/não encontrada no gateway/);
  });

  it("buckpay: consulta pelo external_id do payload e só aceita se o id interno bater com o nosso", async () => {
    const p = await seedPayment("buckpay", "bk-int-1");
    gatewayStatus("buckpay", "our-ref-1", { data: { id: "bk-int-1", status: "paid", total_amount: 1990 } });

    await postWebhook("buckpay", { event: "transaction.processed", data: { id: "bk-int-1", external_id: "our-ref-1", status: "paid", total_amount: 1990 } });

    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    // Guarda a chave de consulta pra conciliação.
    const db = await testDb();
    const [ref] = await db.select().from(paymentReconciliation)
      .where(and(eq(paymentReconciliation.provider, "buckpay"), eq(paymentReconciliation.externalId, "bk-int-1")));
    expect(ref.gatewayRef).toBe("our-ref-1");
  });

  it("buckpay: external_id do payload aponta pra OUTRA cobrança paga → rejeita", async () => {
    const p = await seedPayment("buckpay", "bk-victim");
    // O atacante cita uma cobrança paga qualquer da conta: o id interno não bate.
    gatewayStatus("buckpay", "someone-else", { data: { id: "bk-other", status: "paid", total_amount: 1990 } });

    await postWebhook("buckpay", { event: "transaction.processed", data: { id: "bk-victim", external_id: "someone-else", status: "paid" } });

    expect((await payRepo.findById(p.id))!.status).toBe("pending");
    expect(paidPublishes(p.id)).toBe(0);
  });
});

// ── 2. Processar ANTES de responder ─────────────────────────────────────────
describe("webhook de pagamento — ordem responder/processar", () => {
  it("falha no processamento → responde 500 (nunca 200 antes) e o reenvio aprova", async () => {
    const p = await seedPayment("wiinpay", "wp-retry");
    gatewayStatus("wiinpay", "wp-retry", { data: { paymentId: "wp-retry", status: "PAID", value: 19.9 } });
    vi.spyOn(PaymentDrizzleRepository.prototype, "transitionStatus").mockRejectedValueOnce(new Error("db caiu"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await postWebhook("wiinpay", { data: { paymentId: "wp-retry", status: "PAID" } });
    expect(first.calls).toEqual(["head:500", "end:error"]);
    expect((await payRepo.findById(p.id))!.status).toBe("pending");

    // Gateway reenvia: a idempotência não pode ter "consumido" o evento que falhou.
    const second = await postWebhook("wiinpay", { data: { paymentId: "wp-retry", status: "PAID" } });
    expect(second.calls).toEqual(["head:200", "end:ok"]);
    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    expect(paidPublishes(p.id)).toBe(1);
  });

  it("reentrega de webhook de venda já aprovada não publica de novo", async () => {
    const p = await seedPayment("wiinpay", "wp-dup");
    gatewayStatus("wiinpay", "wp-dup", { data: { paymentId: "wp-dup", status: "PAID", value: 19.9 } });

    await postWebhook("wiinpay", { data: { paymentId: "wp-dup", status: "PAID" } });
    await postWebhook("wiinpay", { data: { paymentId: "wp-dup", status: "PAID" } });

    expect(paidPublishes(p.id)).toBe(1);
  });

  // Replay/forja contra venda já paga e entregue: não pode virar consulta
  // autenticada no gateway a cada POST (amplificação), nem reentregar.
  it("venda já paga e entregue → não consulta o gateway nem republica", async () => {
    const p = await seedPayment("syncpay", "sp-legacy", { status: "paid" });
    const db = await testDb();
    await db.update(payments).set({ deliveryClaimedAt: new Date(), deliveredAt: new Date() }).where(eq(payments.id, p.id));

    const resp = await postWebhook("syncpay", { data: { id: "outro-id", identifier: "sp-legacy", status: "PAID_OUT" } });

    expect(resp.calls).toEqual(["head:200", "end:ok"]);
    expect(gatewayCalls).toHaveLength(0);
    expect(paidPublishes(p.id)).toBe(0);
  });

  it("PIX expirado localmente e pago depois no gateway → confirma (expired → paid)", async () => {
    const p = await seedPayment("wiinpay", "wp-late", { status: "expired" });
    gatewayStatus("wiinpay", "wp-late", { data: { status: "PAID", value: 19.9 } });

    await postWebhook("wiinpay", { data: { paymentId: "wp-late", status: "PAID" } });

    expect((await payRepo.findById(p.id))!.status).toBe("paid");
    expect(paidPublishes(p.id)).toBe(1);
  });
});

// ── Freio de abuso ──────────────────────────────────────────────────────────
describe("webhook de pagamento — freio de abuso", () => {
  it("replay em loop de um mesmo pagamento: consultas ao gateway limitadas, excedente responde 429", async () => {
    const p = await seedPayment("wiinpay", "wp-flood");
    gatewayStatus("wiinpay", "wp-flood", { data: { status: "PENDING", value: 19.9 } });

    const statuses: string[] = [];
    for (let i = 0; i < WEBHOOK_PAYMENT_CHECK_LIMIT.max + 3; i++) {
      const r = await postWebhook("wiinpay", { data: { paymentId: "wp-flood", status: "PAID" } });
      statuses.push(r.calls[0]);
    }

    expect(gatewayCalls).toHaveLength(WEBHOOK_PAYMENT_CHECK_LIMIT.max);
    expect(statuses.slice(-3)).toEqual(["head:429", "head:429", "head:429"]);
    expect((await payRepo.findById(p.id))!.status).toBe("pending");
  });

  it("syncpay: token de auth reaproveitado entre webhooks (sem auth-token por request)", async () => {
    await seedPayment("syncpay", "sp-t1");
    await seedPayment("syncpay", "sp-t2");
    gatewayStatus("syncpay", "sp-t1", { data: { status: "pending", amount: 19.9 } });
    gatewayStatus("syncpay", "sp-t2", { data: { status: "pending", amount: 19.9 } });
    let auths = 0;
    routes.unshift((url) => { if (url.includes("/auth-token")) auths++; return undefined; });

    await postWebhook("syncpay", { data: { identifier: "sp-t1", status: "pending" } });
    await postWebhook("syncpay", { data: { identifier: "sp-t2", status: "pending" } });

    // O seed usa o mesmo client_id nos dois gateways: um único auth-token.
    expect(auths).toBe(1);
  });
});

// ── 3. Conciliação ──────────────────────────────────────────────────────────
describe("conciliação de pagamentos pendentes", () => {
  const MIN = 60_000;

  it("pendente com webhook perdido e pago no gateway → aprovado pela conciliação", async () => {
    const p = await seedPayment("syncpay", "sp-lost", { ageMs: 10 * MIN });
    gatewayStatus("syncpay", "sp-lost", { data: { status: "completed", amount: 19.9 } });

    const r = await reconcilePendingPayments();

    expect(r).toMatchObject({ checked: 1, applied: 1 });
    const got = await payRepo.findById(p.id);
    expect(got!.status).toBe("paid");
    expect(paidPublishes(p.id)).toBe(1);
  });

  it("expirado no gateway → marca expirado", async () => {
    const p = await seedPayment("wiinpay", "wp-exp", { ageMs: 60 * MIN });
    gatewayStatus("wiinpay", "wp-exp", { data: { status: "EXPIRED", value: 19.9 } });

    await reconcilePendingPayments();

    expect((await payRepo.findById(p.id))!.status).toBe("expired");
  });

  it("ainda pendente no gateway → continua pendente e respeita o backoff no tick seguinte", async () => {
    const p = await seedPayment("nexuspag", "nx-wait", { ageMs: 10 * MIN });
    gatewayStatus("nexuspag", "nx-wait", { status: "pending", amount: 19.9 });

    await reconcilePendingPayments();
    expect(gatewayCalls.filter((u) => u.endsWith("/api/pix/nx-wait"))).toHaveLength(1);
    expect((await payRepo.findById(p.id))!.status).toBe("pending");

    // Um minuto depois ainda não é hora de consultar de novo (max(2min, idade/4)).
    await reconcilePendingPayments(new Date(Date.now() + MIN));
    expect(gatewayCalls.filter((u) => u.endsWith("/api/pix/nx-wait"))).toHaveLength(1);

    // Passado o intervalo, consulta de novo.
    await reconcilePendingPayments(new Date(Date.now() + 4 * MIN));
    expect(gatewayCalls.filter((u) => u.endsWith("/api/pix/nx-wait"))).toHaveLength(2);
  });

  it("buckpay sem chave de consulta (PIX anterior à 0020) → contado à parte, sem consulta", async () => {
    await seedPayment("buckpay", "bk-legacy", { ageMs: 10 * MIN });

    const r = await reconcilePendingPayments();

    expect(r).toMatchObject({ checked: 1, noLookupKey: 1, applied: 0 });
    expect(gatewayCalls).toHaveLength(0);
  });

  it("não consulta PIX recém-criado (webhook ainda pode chegar) nem mais velho que 24h", async () => {
    await seedPayment("wiinpay", "wp-new", { ageMs: 30_000 });
    await seedPayment("wiinpay", "wp-old", { ageMs: 25 * 60 * MIN });
    await seedPayment("wiinpay", "wp-paid", { ageMs: 10 * MIN, status: "paid" });

    const r = await reconcilePendingPayments();

    expect(r.checked).toBe(0);
    expect(gatewayCalls).toHaveLength(0);
  });

  it("buckpay: a chave de consulta guardada na criação do PIX é usada pela conciliação", async () => {
    const bot  = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const gw   = (await gwRepo.findById(gwId))!;
    const res  = await createPixWithFallback([gw], { amountCents: 1990, description: "P", webhookUrl: () => "https://x/wh", ownerUserId: bot.userId });
    const ref  = res!.pix.gatewayRef!;
    expect(ref).toBeTruthy();

    const p = await payRepo.create({
      userId: bot.userId, botId: bot.id, gatewayId: gwId, amount: 1990, status: "pending",
      externalId: res!.pix.externalId, pixCode: res!.pix.pixCode, leadId: null,
    });
    const db = await testDb();
    await db.update(payments).set({ createdAt: new Date(Date.now() - 10 * MIN) }).where(eq(payments.id, p.id));
    gatewayStatus("buckpay", ref, { data: { id: res!.pix.externalId, status: "paid", total_amount: 1990 } });

    await reconcilePendingPayments();

    expect((await payRepo.findById(p.id))!.status).toBe("paid");
  });
});

// ── Interpretação do status consultado ─────────────────────────────────────
describe("fetchChargeStatus", () => {
  it("wiinpay: UNPAID não é pago (match exato, nunca substring)", async () => {
    gatewayStatus("wiinpay", "w-unpaid", { data: { status: "UNPAID", value: 10 } });
    const s = await fetchChargeStatus("wiinpay", { clientId: "k", clientSecret: "" }, "w-unpaid");
    expect(s!.status).toBe("pending");
  });

  it("resposta sem status → indisponível (não afirma nada)", async () => {
    gatewayStatus("nexuspag", "n-empty", { ok: true });
    await expect(fetchChargeStatus("nexuspag", { clientId: "k", clientSecret: "" }, "n-empty"))
      .rejects.toThrow(/não informou o status/);
  });
});
