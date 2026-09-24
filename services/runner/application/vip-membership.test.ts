import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../../test/helpers/db.js";
import { botGroups, vipMembers, payments, funnelOffers, bots, funnels, leads } from "../../shared/schema/index.js";
import {
  createBot, createGateway, createLead, createFlowFunnel, createSimplifiedFunnel, startUpdate, callbackUpdate,
} from "../../../test/helpers/seed.js";
import { getTelegramCalls, forceTelegramError } from "../../../test/helpers/fetch-mock.js";
import { registerOrRenewVipMembership, expireDueVipMemberships, previewVipInviteExpireEpoch } from "./vip-membership.js";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { ExecuteSimplifiedFunnelUseCase } from "./execute-simplified-funnel.use-case.js";
import { TelegramClient } from "./telegram.client.js";
import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import * as pushModule from "../../notifications/application/send-push.use-case.js";

const useCase    = new ExecuteFlowStepUseCase();
const simplified = new ExecuteSimplifiedFunnelUseCase();
const payRepo    = new PaymentDrizzleRepository();

async function createGroup(botId: string, chatId: bigint) {
  const db = await testDb();
  const [row] = await db.insert(botGroups).values({ botId, name: "Grupo VIP", telegramChatId: chatId }).returning();
  return row;
}

// ── registerOrRenewVipMembership (unidade) ──────────────────────────────────

describe("registerOrRenewVipMembership", () => {
  it("registra novo membro com vencimento calculado a partir de access_days", async () => {
    const bot = await createBot();
    const group = await createGroup(bot.id, -100100n);

    await registerOrRenewVipMembership({
      botId: bot.id, groupTelegramChatId: "-100100", memberTelegramChatId: 555n,
      username: "joao", firstName: "João", lastName: "Silva", accessDays: 30,
      paymentId: null, offerId: null,
    });

    const db = await testDb();
    const [m] = await db.select().from(vipMembers);
    expect(m).toBeDefined();
    expect(m.groupId).toBe(group.id);
    expect(m.telegramChatId).toBe(555n);
    expect(m.username).toBe("joao");
    expect(m.accessDays).toBe(30);
    expect(m.isBlocked).toBe(false);
    expect(m.expiresAt).not.toBeNull();
    const daysFromNow = (m.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(daysFromNow).toBeGreaterThan(29);
    expect(daysFromNow).toBeLessThan(31);
  });

  it("oferta vitalícia (accessDays vazio) não define vencimento", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -100200n);

    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100200", memberTelegramChatId: 1n, accessDays: null });

    const db = await testDb();
    const [m] = await db.select().from(vipMembers);
    expect(m.expiresAt).toBeNull();
    expect(m.accessDays).toBeNull();
  });

  it("renovação de assinatura ainda ativa ESTENDE o vencimento (soma os dias) em vez de duplicar a linha", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -100300n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100300", memberTelegramChatId: 2n, accessDays: 10 });

    const db = await testDb();
    const [first] = await db.select().from(vipMembers);

    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100300", memberTelegramChatId: 2n, accessDays: 10 });

    const rows = await db.select().from(vipMembers);
    expect(rows.length).toBe(1); // não duplicou — mesma linha (bot_id, group_id, telegram_chat_id)
    const extendedByMs = rows[0].expiresAt!.getTime() - first.expiresAt!.getTime();
    expect(extendedByMs).toBeGreaterThan(9 * 86_400_000); // ~10 dias somados ao vencimento anterior
  });

  it("renovação de assinatura já EXPIRADA reativa (desbloqueia) e conta os dias a partir de AGORA, não do vencimento antigo", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -100400n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100400", memberTelegramChatId: 3n, accessDays: 5 });

    const db = await testDb();
    // Simula o job de expiração já tendo rodado (vencimento há 100 dias, banido).
    await db.update(vipMembers).set({
      expiresAt: new Date(Date.now() - 100 * 86_400_000), expiredAt: new Date(), isBlocked: true,
    });

    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100400", memberTelegramChatId: 3n, accessDays: 5, paymentId: null, offerId: null });

    const [m] = await db.select().from(vipMembers);
    expect(m.isBlocked).toBe(false);
    expect(m.expiredAt).toBeNull();
    const daysFromNow = (m.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(daysFromNow).toBeGreaterThan(4);
    expect(daysFromNow).toBeLessThan(6); // contado a partir de agora — não herdou o vencimento vencido há 100 dias
  });

  it("vitalício ATIVO não é rebaixado por uma entrega seguinte com prazo definido (ex.: bump/reenvio)", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -100450n);
    // 1ª entrega: oferta vitalícia (accessDays vazio).
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100450", memberTelegramChatId: 4n, accessDays: null });

    // 2ª entrega pro MESMO membro/grupo, agora com prazo finito — não pode
    // rebaixar quem já tinha vitalício, senão o job de expiração bane quem
    // pagou por acesso vitalício.
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100450", memberTelegramChatId: 4n, accessDays: 15 });

    const db = await testDb();
    const rows = await db.select().from(vipMembers);
    expect(rows.length).toBe(1);
    expect(rows[0].expiresAt).toBeNull();  // continua vitalício
    expect(rows[0].accessDays).toBeNull();
  });

  it("(cenário de falha) grupo do convite não existe mais em bot_groups — não registra nada, mas não lança", async () => {
    const bot = await createBot();

    await expect(registerOrRenewVipMembership({
      botId: bot.id, groupTelegramChatId: "-999999", memberTelegramChatId: 9n, accessDays: 30,
    })).resolves.toBeUndefined();

    const db = await testDb();
    expect((await db.select().from(vipMembers)).length).toBe(0);
  });

  it("(cenário de falha) chat id de grupo inválido/não numérico — não registra nada, não lança", async () => {
    const bot = await createBot();

    await expect(registerOrRenewVipMembership({
      botId: bot.id, groupTelegramChatId: "não-é-um-id", memberTelegramChatId: 9n, accessDays: 30,
    })).resolves.toBeUndefined();

    const db = await testDb();
    expect((await db.select().from(vipMembers)).length).toBe(0);
  });
});

describe("previewVipInviteExpireEpoch", () => {
  it("renovação de assinatura ainda ativa: expire_date do CONVITE bate com o vencimento EMPILHADO, não só os dias desta compra", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -100460n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100460", memberTelegramChatId: 5n, accessDays: 20 });
    const db = await testDb();
    const [m] = await db.select().from(vipMembers);

    const epoch = await previewVipInviteExpireEpoch(bot.id, "-100460", 5n, 20);

    // Vencimento empilhado ~= atual (20 dias) + mais 20 dias da renovação —
    // bem mais longe do que "só 20 dias a partir de agora".
    const expectedMs = m.expiresAt!.getTime() + 20 * 86_400_000;
    expect(Math.abs(epoch! * 1000 - expectedMs)).toBeLessThan(5_000);
  });

  it("compra vitalícia não tem expire_date no convite", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -100470n);
    const epoch = await previewVipInviteExpireEpoch(bot.id, "-100470", 6n, null);
    expect(epoch).toBeUndefined();
  });

  it("assinatura atual vitalícia: convite da entrega seguinte também não tem expire_date (preserva vitalício)", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -100480n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-100480", memberTelegramChatId: 7n, accessDays: null });
    const epoch = await previewVipInviteExpireEpoch(bot.id, "-100480", 7n, 10);
    expect(epoch).toBeUndefined();
  });
});

// ── Entrega real (integração): os 3 caminhos que geram convite de grupo VIP ──

describe("entrega de oferta vip_group registra o membro em vip_members", () => {
  it("funil FLOW — oferta embutida no node (telegram_group_id = chat id literal)", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    await createGroup(bot.id, -555111n);
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers: [{
          gateway_id: gwId, product_name: "VIP", price: 29.9, callback: "vip", button_text: "Entrar",
          product_type: "vip_group", telegram_group_id: "-555111", access_days: 15,
        }] } },
        { key: "paid", type: "message", content: { message: "ACESSO-LIBERADO" } },
      ],
      connections: [{ from: "t", to: "off" }, { from: "off", to: "paid", handle: "vip__paid" }],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(9001) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(9001, "offer:0") });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    await useCase.handlePaidOffer((await payRepo.findById(pay.id))!);

    expect(getTelegramCalls("createChatInviteLink").length).toBe(1);
    const [member] = await db.select().from(vipMembers);
    expect(member).toBeDefined();
    expect(member.telegramChatId).toBe(9001n);
    expect(member.accessDays).toBe(15);
    expect(member.paymentId).toBe(pay.id);
    expect(member.offerId).toBeNull(); // oferta embutida em node não tem linha em funnel_offers
  });

  it("funil SIMPLIFICADO — plano com delivery_type vip_group", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const group = await createGroup(bot.id, -555222n);
    const funnelId = await createSimplifiedFunnel({
      userId: bot.userId, botId: bot.id,
      config: {
        payment: { gateway_id: gwId },
        plans: [{ id: "p1", name: "VIP", price: 19.9, delivery_type: "vip_group", vip_group_id: "-555222", access_days: 7 }],
      },
    });
    const chatId = 9002n;
    await createLead(bot.id, chatId);

    const db = await testDb();
    const [botRow]    = await db.select().from(bots).where(eq(bots.id, bot.id));
    const [funnelRow] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    const [leadRow]   = await db.select().from(leads).where(eq(leads.telegramChatId, chatId));
    const tg = new TelegramClient("test");

    await simplified.handle({
      bot: botRow, lead: leadRow, chatId: chatId.toString(), funnel: funnelRow,
      text: null, callbackData: "sp_p1", callbackMessageId: 1, tg,
    });
    const [pay] = await db.select().from(payments);
    await simplified.deliverPaid((await payRepo.findById(pay.id))!);

    const [member] = await db.select().from(vipMembers);
    expect(member).toBeDefined();
    expect(member.groupId).toBe(group.id);
    expect(member.telegramChatId).toBe(chatId);
    expect(member.accessDays).toBe(7);
    expect(member.paymentId).toBe(pay.id);
  });

  it("compra avulsa via catálogo de ofertas (funnel_offers, telegramGroupId = uuid de bot_groups) resolve o grupo pelo join e registra o membro", async () => {
    const bot = await createBot();
    const group = await createGroup(bot.id, -555333n);
    const leadId = await createLead(bot.id, 9003n);
    const gwId = await createGateway({ userId: bot.userId });

    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({
      botId: bot.id, name: "VIP avulso", price: 4990, productType: "vip_group",
      telegramGroupId: group.id, accessDays: 20,
    }).returning();
    const created = await payRepo.create({
      userId: bot.userId, botId: bot.id, leadId, gatewayId: gwId,
      offerId: offer.id, offerName: offer.name, amount: 4990, status: "paid",
    });

    await useCase.handlePaidOffer((await payRepo.findById(created.id))!);

    const [member] = await db.select().from(vipMembers);
    expect(member).toBeDefined();
    expect(member.groupId).toBe(group.id);
    expect(member.offerId).toBe(offer.id);
    expect(member.paymentId).toBe(created.id);
    expect(member.accessDays).toBe(20);
  });
});

// ── Expiração automática (job do runner) ────────────────────────────────────

describe("expireDueVipMemberships", () => {
  it("membro vencido é banido+desbanido do grupo (pode voltar a entrar) e marcado como expirado", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -700100n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-700100", memberTelegramChatId: 42n, accessDays: 1 });
    const db = await testDb();
    await db.update(vipMembers).set({ expiresAt: new Date(Date.now() - 60_000) }); // força vencido

    const n = await expireDueVipMemberships();
    expect(n).toBe(1);

    const bans   = getTelegramCalls("banChatMember");
    const unbans = getTelegramCalls("unbanChatMember");
    expect(bans.length).toBe(1);
    expect(bans[0].body.chat_id).toBe("-700100");
    expect(bans[0].body.user_id).toBe(42);
    expect(unbans.length).toBe(1);
    expect(unbans[0].body.chat_id).toBe("-700100");

    const [m] = await db.select().from(vipMembers);
    expect(m.expiredAt).not.toBeNull();
    expect(m.isBlocked).toBe(true);
  });

  it("membro ainda dentro do prazo não é tocado", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -700200n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-700200", memberTelegramChatId: 43n, accessDays: 30 });

    const n = await expireDueVipMemberships();
    expect(n).toBe(0);
    expect(getTelegramCalls("banChatMember").length).toBe(0);
  });

  it("(idempotência / múltiplas réplicas) rodar de novo depois de expirar não reprocessa nem bane duas vezes", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -700300n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-700300", memberTelegramChatId: 44n, accessDays: 1 });
    const db = await testDb();
    await db.update(vipMembers).set({ expiresAt: new Date(Date.now() - 60_000) });

    const n1 = await expireDueVipMemberships();
    const n2 = await expireDueVipMemberships();
    expect(n1).toBe(1);
    expect(n2).toBe(0); // já expirado — segunda passada não pega de novo
    expect(getTelegramCalls("banChatMember").length).toBe(1); // não dobrou o ban
  });

  it("(cenário de falha) erro inesperado do Telegram no ban NÃO marca como expirado — fica pendente pra nova tentativa", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -700400n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-700400", memberTelegramChatId: 45n, accessDays: 1 });
    const db = await testDb();
    await db.update(vipMembers).set({ expiresAt: new Date(Date.now() - 60_000) });
    forceTelegramError("banChatMember", 500, "erro genérico do Telegram");

    const n = await expireDueVipMemberships();
    expect(n).toBe(0);

    const [m] = await db.select().from(vipMembers);
    expect(m.expiredAt).toBeNull();
    expect(m.isBlocked).toBe(false);
  });

  it("(falha esperada) 400 — usuário já não está no grupo/chat inválido — ainda assim marca o membro como expirado", async () => {
    const bot = await createBot();
    await createGroup(bot.id, -700500n);
    await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-700500", memberTelegramChatId: 46n, accessDays: 1 });
    const db = await testDb();
    await db.update(vipMembers).set({ expiresAt: new Date(Date.now() - 60_000) });
    forceTelegramError("banChatMember", 400, "chat inválido");

    const n = await expireDueVipMemberships();
    expect(n).toBe(1);

    const [m] = await db.select().from(vipMembers);
    expect(m.expiredAt).not.toBeNull();
    expect(m.isBlocked).toBe(true);
  });

  it("(cenário de falha) 403 — bot SEM permissão de admin no grupo — o ban falhou de verdade: NÃO marca expirado, e avisa o dono", async () => {
    const pushSpy = vi.spyOn(pushModule, "sendPushToUser").mockResolvedValue({ sent: 0, failed: 0, removed: 0 });
    try {
      const bot = await createBot();
      await createGroup(bot.id, -700510n);
      await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-700510", memberTelegramChatId: 47n, accessDays: 1 });
      const db = await testDb();
      await db.update(vipMembers).set({ expiresAt: new Date(Date.now() - 60_000) });
      forceTelegramError("banChatMember", 403, "bot não é mais admin do grupo");

      const n = await expireDueVipMemberships();
      expect(n).toBe(0); // diferente de 400: o membro continua no grupo de verdade

      const [m] = await db.select().from(vipMembers);
      expect(m.expiredAt).toBeNull();
      expect(m.isBlocked).toBe(false);

      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy.mock.calls[0][1].eventType).toBe("vip_group_permission_lost");
    } finally {
      pushSpy.mockRestore();
    }
  });

  it("(dedup) dois membros vencidos do MESMO grupo com 403 avisam o dono só uma vez", async () => {
    const pushSpy = vi.spyOn(pushModule, "sendPushToUser").mockResolvedValue({ sent: 0, failed: 0, removed: 0 });
    try {
      const bot = await createBot();
      await createGroup(bot.id, -700520n);
      await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-700520", memberTelegramChatId: 61n, accessDays: 1 });
      await registerOrRenewVipMembership({ botId: bot.id, groupTelegramChatId: "-700520", memberTelegramChatId: 62n, accessDays: 1 });
      const db = await testDb();
      await db.update(vipMembers).set({ expiresAt: new Date(Date.now() - 60_000) });
      forceTelegramError("banChatMember", 403, "bot não é mais admin do grupo");

      const n = await expireDueVipMemberships();
      expect(n).toBe(0);
      expect(pushSpy).toHaveBeenCalledTimes(1); // mesmo grupo — não dobra o aviso
    } finally {
      pushSpy.mockRestore();
    }
  });
});
