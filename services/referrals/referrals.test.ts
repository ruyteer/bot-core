// Indique e Ganhe — regras de negócio:
// 1. Comissão = % (override do indicador > config global > 20) sobre a taxa da
//    plataforma (R$0,40/venda ou USER_SPLIT_FEE_CENTS_<seller>), creditada
//    quando a venda do indicado é paga. Idempotente por payment_id.
// 2. Seller admin não gera taxa (PIX sem split) → não gera comissão.
// 3. Saque: mínimo, saldo suficiente e um pendente por vez; rejeitar devolve
//    o valor ao saldo.
import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createProfile, createBot, createGateway } from "../../test/helpers/seed.js";
import {
  payments, referrals, referralCodes, referralCommissions,
  referralWithdrawals, platformConfig, userRoles, profiles,
} from "../shared/schema/index.js";
import { accrueReferralCommission } from "./application/accrue-commission.js";
import { ensureReferralCode, commissionPercentFor } from "./application/referral-config.js";
import { isUniqueViolation } from "../shared/db-errors.js";
import { __setTestDb } from "../shared/database.js";

// requestWithdrawal/adminProcessWithdrawal usam getAuthData (via ~encore/auth)
// para identificar o usuário — mockado aqui para controlar o autenticado por
// teste (mesmo padrão de notifications.test.ts/broadcasts.api.test.ts).
let authUserId: string | null = null;
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));
const { requestWithdrawal, adminProcessWithdrawal } = await import("./referrals.api.js");

async function createAdmin(): Promise<string> {
  const db = await testDb();
  const admin = await createProfile();
  await db.insert(userRoles).values({ userId: admin, role: "admin" });
  return admin;
}

async function createPaidPayment(sellerUserId: string): Promise<string> {
  const db = await testDb();
  const bot = await createBot({ userId: sellerUserId });
  const gatewayId = await createGateway({ userId: sellerUserId });
  const [row] = await db.insert(payments).values({
    userId:    sellerUserId,
    botId:     bot.id,
    gatewayId,
    amount:    600,
    status:    "paid",
  }).returning({ id: payments.id });
  return row.id;
}

async function linkReferral(referrerUserId: string, referredUserId: string): Promise<void> {
  const db = await testDb();
  await db.insert(referrals).values({ referredUserId, referrerUserId });
}

describe("accrueReferralCommission", () => {
  it("credita 20% da taxa padrão (R$0,40) = 8 centavos por venda paga", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const seller   = await createProfile();
    await linkReferral(referrer, seller);
    const paymentId = await createPaidPayment(seller);

    await accrueReferralCommission(paymentId, seller);

    const rows = await db.select().from(referralCommissions);
    expect(rows).toHaveLength(1);
    expect(rows[0].referrerUserId).toBe(referrer);
    expect(rows[0].baseFeeCents).toBe(40);
    expect(rows[0].percent).toBe(20);
    expect(rows[0].amountCents).toBe(8);
  });

  it("é idempotente: reprocessar o mesmo pagamento não duplica a comissão", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const seller   = await createProfile();
    await linkReferral(referrer, seller);
    const paymentId = await createPaidPayment(seller);

    await accrueReferralCommission(paymentId, seller);
    await accrueReferralCommission(paymentId, seller);

    expect(await db.select().from(referralCommissions)).toHaveLength(1);
  });

  it("seller sem indicador não gera comissão", async () => {
    const db = await testDb();
    const seller = await createProfile();
    const paymentId = await createPaidPayment(seller);
    await accrueReferralCommission(paymentId, seller);
    expect(await db.select().from(referralCommissions)).toHaveLength(0);
  });

  it("respeita o % custom do indicador (comissão aumentada)", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const seller   = await createProfile();
    await db.insert(referralCodes).values({ userId: referrer, code: "vip50", commissionPercent: 50 });
    await linkReferral(referrer, seller);
    const paymentId = await createPaidPayment(seller);

    await accrueReferralCommission(paymentId, seller);

    const [row] = await db.select().from(referralCommissions);
    expect(row.percent).toBe(50);
    expect(row.amountCents).toBe(20); // 50% de 40
  });

  it("usa a taxa override do seller (USER_SPLIT_FEE_CENTS) como base", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const seller   = await createProfile();
    await linkReferral(referrer, seller);
    await db.insert(platformConfig).values({ key: `USER_SPLIT_FEE_CENTS_${seller}`, value: "100" });
    const paymentId = await createPaidPayment(seller);

    await accrueReferralCommission(paymentId, seller);

    const [row] = await db.select().from(referralCommissions);
    expect(row.baseFeeCents).toBe(100);
    expect(row.amountCents).toBe(20); // 20% de 100
  });

  it("seller admin (venda sem split) não gera comissão", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const seller   = await createProfile();
    await db.insert(userRoles).values({ userId: seller, role: "admin" });
    await linkReferral(referrer, seller);
    const paymentId = await createPaidPayment(seller);

    await accrueReferralCommission(paymentId, seller);

    expect(await db.select().from(referralCommissions)).toHaveLength(0);
  });
});

describe("ensureReferralCode / commissionPercentFor", () => {
  it("cria o código na primeira chamada e reusa depois", async () => {
    const user = await createProfile();
    const code1 = await ensureReferralCode(user);
    const code2 = await ensureReferralCode(user);
    expect(code1).toBe(code2);
    expect(code1).toMatch(/^[a-z2-9]{8}$/);
  });

  it("% global via platform_config vale quando não há override individual", async () => {
    const db = await testDb();
    const user = await createProfile();
    await db.insert(platformConfig).values({ key: "REFERRAL_COMMISSION_PERCENT", value: "35" });
    expect(await commissionPercentFor(user)).toBe(35);
  });
});

describe("saques (fluxo manual)", () => {
  // Os endpoints usam getAuthData; aqui testamos a regra de saldo via SQL
  // direto + o efeito de rejeitar (status muda, saldo volta).
  it("rejeitar um saque devolve o valor ao saldo disponível", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const seller   = await createProfile();
    await linkReferral(referrer, seller);
    // 3 vendas pagas → 24 centavos
    for (let i = 0; i < 3; i++) {
      const p = await createPaidPayment(seller);
      await accrueReferralCommission(p, seller);
    }

    const [w] = await db.insert(referralWithdrawals)
      .values({ userId: referrer, amountCents: 24, pixKey: "a@b.c" })
      .returning();

    // Pendente: saldo = 24 - 24 = 0
    const sumPending = async () => {
      const rows = await db.select().from(referralWithdrawals)
        .where(eq(referralWithdrawals.userId, referrer));
      return rows.filter((r) => r.status === "pending" || r.status === "paid")
        .reduce((s, r) => s + r.amountCents, 0);
    };
    expect(await sumPending()).toBe(24);

    await db.update(referralWithdrawals)
      .set({ status: "rejected", processedAt: new Date() })
      .where(eq(referralWithdrawals.id, w.id));
    expect(await sumPending()).toBe(0);
  });

  it("cascade: excluir o perfil do indicador limpa códigos e comissões", async () => {
    const db = await testDb();
    const referrer = await createProfile();
    const seller   = await createProfile();
    await ensureReferralCode(referrer);
    await linkReferral(referrer, seller);
    const p = await createPaidPayment(seller);
    await accrueReferralCommission(p, seller);

    await db.delete(profiles).where(eq(profiles.id, referrer));

    expect(await db.select().from(referralCodes)).toHaveLength(0);
    expect(await db.select().from(referralCommissions)).toHaveLength(0);
    expect(await db.select().from(referrals)).toHaveLength(0);
  });

  // Race condition (item de backlog corrida-race-condition-em-pedido-de-saque-de-
  // comissao-de-ind-5x2ugm): índice único parcial (migration 0015) barrando dois
  // saques pending do mesmo usuário, transação em requestWithdrawal como defesa em
  // profundidade, e recheck de saldo + UPDATE condicionado em adminProcessWithdrawal.

  it("índice único parcial barra um segundo INSERT pending do mesmo usuário (23505)", async () => {
    const db = await testDb();
    const user = await createProfile();
    await db.insert(referralWithdrawals).values({ userId: user, amountCents: 10, pixKey: "a@b.c" });

    let error: unknown;
    try {
      await db.insert(referralWithdrawals).values({ userId: user, amountCents: 10, pixKey: "a@b.c" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(isUniqueViolation(error, "referral_withdrawals_pending_user_unique")).toBe(true);
  });

  // NOTA: PGlite roda numa conexão única, então `db.transaction()` serializa
  // completamente — a 1ª transação faz BEGIN…COMMIT inteira antes da 2ª emitir
  // seu próprio BEGIN. Na prática isso significa que a 2ª chamada é barrada
  // pelo SELECT de "já existe pendente" DENTRO da própria transação (a barreira
  // de aplicação, que já existia antes deste diff) — nunca chega a tentar o
  // INSERT que colidiria com o índice único. Este teste cobre essa barreira de
  // aplicação sob serialização do PGlite, NÃO o catch do 23505/índice único;
  // esse caminho é coberto isoladamente no teste seguinte (mock do INSERT).
  it("duas chamadas concorrentes de requestWithdrawal pro mesmo usuário: a barreira de aplicação (check-then-act) deixa só uma criar o saque pending", async () => {
    const referrer = await createProfile();
    const seller   = await createProfile();
    await linkReferral(referrer, seller);
    const db = await testDb();
    // Taxa alta pro seller (USER_SPLIT_FEE_CENTS) pra gerar saldo acima do
    // saque mínimo (R$10 = 1000 centavos) sem precisar de muitas vendas.
    await db.insert(platformConfig).values({ key: `USER_SPLIT_FEE_CENTS_${seller}`, value: "10000" });
    for (let i = 0; i < 3; i++) {
      const p = await createPaidPayment(seller);
      await accrueReferralCommission(p, seller);
    } // 3 × (20% de 10000) = 6000 centavos de saldo

    authUserId = referrer;
    const results = await Promise.allSettled([
      requestWithdrawal({ amountCents: 2000, pixKey: "a@b.c" }),
      requestWithdrawal({ amountCents: 2000, pixKey: "a@b.c" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected  = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringContaining("já tem um saque pendente"),
    });

    const pendingRows = await db.select().from(referralWithdrawals)
      .where(and(eq(referralWithdrawals.userId, referrer), eq(referralWithdrawals.status, "pending")));
    expect(pendingRows).toHaveLength(1);
  });

  it("catch do 23505 traduz a violação do índice único (referral_withdrawals_pending_user_unique) pra APIError amigável — força o INSERT a colidir, sem depender de concorrência real do PGlite", async () => {
    const realDb = await testDb();
    const referrer = await createProfile();
    const seller   = await createProfile();
    await linkReferral(referrer, seller);
    // Taxa alta pro seller (USER_SPLIT_FEE_CENTS) pra gerar saldo acima do
    // saque mínimo (R$10 = 1000 centavos) com uma venda só.
    await realDb.insert(platformConfig).values({ key: `USER_SPLIT_FEE_CENTS_${seller}`, value: "10000" });
    const p = await createPaidPayment(seller);
    await accrueReferralCommission(p, seller); // 20% de 10000 = 2000 centavos de saldo

    // Substitui só o `db.transaction` por uma versão cujo INSERT sempre rejeita
    // com o shape real de um unique_violation do Postgres (23505 + nome da
    // constraint) — o SELECT de "já existe pendente" continua rodando de
    // verdade contra o PGlite (e não encontra nada), então o único jeito do
    // teste passar é o catch de requestWithdrawal (referrals.api.ts) traduzir
    // esse erro simulado pra APIError.failedPrecondition.
    const fakeTx = {
      select: realDb.select.bind(realDb),
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw Object.assign(
              new Error('duplicate key value violates unique constraint "referral_withdrawals_pending_user_unique"'),
              { code: "23505", constraint: "referral_withdrawals_pending_user_unique" },
            );
          },
        }),
      }),
    };
    const fakeDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "transaction") return async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx);
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    __setTestDb(fakeDb as unknown as Parameters<typeof __setTestDb>[0]);
    try {
      authUserId = referrer;
      await expect(requestWithdrawal({ amountCents: 1500, pixKey: "a@b.c" })).rejects.toMatchObject({
        code:    "failed_precondition",
        message: "você já tem um saque pendente — aguarde o processamento",
      });
    } finally {
      __setTestDb(realDb as unknown as Parameters<typeof __setTestDb>[0]);
    }

    // Nada foi persistido de fato — era o INSERT simulado que colidiu.
    const pendingRows = await realDb.select().from(referralWithdrawals)
      .where(and(eq(referralWithdrawals.userId, referrer), eq(referralWithdrawals.status, "pending")));
    expect(pendingRows).toHaveLength(0);
  });

  it("aprovar um segundo saque quando o saldo já foi consumido pela aprovação do primeiro é rejeitado pela recheck", async () => {
    const referrer = await createProfile();
    const seller   = await createProfile();
    await linkReferral(referrer, seller);
    for (let i = 0; i < 2; i++) {
      const p = await createPaidPayment(seller);
      await accrueReferralCommission(p, seller);
    } // 2 × 8 = 16 centavos de saldo

    const db = await testDb();
    const [w1] = await db.insert(referralWithdrawals)
      .values({ userId: referrer, amountCents: 16, pixKey: "a@b.c" })
      .returning();

    const admin = await createAdmin();
    authUserId = admin;
    await adminProcessWithdrawal({ id: w1.id, action: "paid" });

    const [w2] = await db.insert(referralWithdrawals)
      .values({ userId: referrer, amountCents: 8, pixKey: "a@b.c" })
      .returning();

    await expect(adminProcessWithdrawal({ id: w2.id, action: "paid" })).rejects.toMatchObject({
      code:    "failed_precondition",
      message: expect.stringContaining("não cobre"),
    });

    const [reloaded] = await db.select().from(referralWithdrawals).where(eq(referralWithdrawals.id, w2.id));
    expect(reloaded.status).toBe("pending");
  });

  it("um saque rejeitado libera o índice pra um novo pending do mesmo usuário", async () => {
    const db = await testDb();
    const user = await createProfile();
    const [w1] = await db.insert(referralWithdrawals)
      .values({ userId: user, amountCents: 10, pixKey: "a@b.c" })
      .returning();

    await db.update(referralWithdrawals)
      .set({ status: "rejected", processedAt: new Date() })
      .where(eq(referralWithdrawals.id, w1.id));

    const [w2] = await db.insert(referralWithdrawals)
      .values({ userId: user, amountCents: 10, pixKey: "a@b.c" })
      .returning();
    expect(w2.id).toBeDefined();

    const pendingRows = await db.select().from(referralWithdrawals)
      .where(and(eq(referralWithdrawals.userId, user), eq(referralWithdrawals.status, "pending")));
    expect(pendingRows).toHaveLength(1);
  });

  it("duas aprovações concorrentes do mesmo saque: só uma tem efeito, a outra é rejeitada", async () => {
    const referrer = await createProfile();
    const seller   = await createProfile();
    await linkReferral(referrer, seller);
    const p = await createPaidPayment(seller);
    await accrueReferralCommission(p, seller); // 8 centavos de saldo

    const db = await testDb();
    const [w] = await db.insert(referralWithdrawals)
      .values({ userId: referrer, amountCents: 8, pixKey: "a@b.c" })
      .returning();

    const admin = await createAdmin();
    authUserId = admin;
    const results = await Promise.allSettled([
      adminProcessWithdrawal({ id: w.id, action: "rejected" }),
      adminProcessWithdrawal({ id: w.id, action: "rejected" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected  = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "failed_precondition" });

    const [reloaded] = await db.select().from(referralWithdrawals).where(eq(referralWithdrawals.id, w.id));
    expect(reloaded.status).toBe("rejected");
  });
});
