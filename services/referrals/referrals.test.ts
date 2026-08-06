// Indique e Ganhe — regras de negócio:
// 1. Comissão = % (override do indicador > config global > 20) sobre a taxa da
//    plataforma (R$0,40/venda ou USER_SPLIT_FEE_CENTS_<seller>), creditada
//    quando a venda do indicado é paga. Idempotente por payment_id.
// 2. Seller admin não gera taxa (PIX sem split) → não gera comissão.
// 3. Saque: mínimo, saldo suficiente e um pendente por vez; rejeitar devolve
//    o valor ao saldo.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createProfile, createBot, createGateway } from "../../test/helpers/seed.js";
import {
  payments, referrals, referralCodes, referralCommissions,
  referralWithdrawals, platformConfig, userRoles, profiles,
} from "../shared/schema/index.js";
import { accrueReferralCommission } from "./application/accrue-commission.js";
import { ensureReferralCode, commissionPercentFor } from "./application/referral-config.js";

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
});
