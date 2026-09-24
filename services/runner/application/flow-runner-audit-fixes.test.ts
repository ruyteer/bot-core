// Cobertura dos achados da auditoria do runner do funil de FLUXO
// (execute-flow-step.use-case.ts):
//   1. dedupe de update_id do Telegram + índice único em lead_progress
//   2. escopo da limpeza de scheduled_delays (não apaga o timeout de uma
//      oferta IRMÃ que o lead não tocou)
//   3. beco sem saída silencioso (botão sem conexão) vira log + stallReason
//   4. falha ao gerar PIX não deixa o lead sem timeout
// (achado 5, escape de HTML nos textos de PIX, é coberto no PR #64 —
// pix-messages.test.ts tem a parte que sobrou deste lado)
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { processPendingDelays } from "../runner.js";
import { testDb } from "../../../test/helpers/db.js";
import { leadProgress, scheduledDelays, leads, payments } from "../../shared/schema/index.js";
import {
  createBot, createGateway, createFlowFunnel, createLead, startUpdate, callbackUpdate,
} from "../../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls, forceGatewayError } from "../../../test/helpers/fetch-mock.js";

const useCase = new ExecuteFlowStepUseCase();
const payRepo = new PaymentDrizzleRepository();

describe("Achado 1 — dedupe de update do Telegram", () => {
  it("o MESMO update (mesmo update_id) processado 2x roda o passo do funil só uma vez", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });

    const update = startUpdate(9001);
    await useCase.execute({ botId: bot.id, update });
    await useCase.execute({ botId: bot.id, update }); // reentrega (retry do pubsub/webhook)

    expect(getSentMessages().filter((m) => m === "Bem-vindo!")).toHaveLength(1);
  });
});

describe("Achado 1 — índice único de lead_progress", () => {
  it("não permite duas linhas de progresso pro mesmo lead", async () => {
    const bot = await createBot();
    const { funnelId, nodeIds } = await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [{ key: "trigger", type: "trigger" }],
      connections: [],
    });
    const leadId = await createLead(bot.id, 9101n);
    const db = await testDb();
    await db.insert(leadProgress).values({ leadId, funnelId, currentNodeId: nodeIds.trigger, status: "active" });

    await expect(
      db.insert(leadProgress).values({ leadId, funnelId, currentNodeId: nodeIds.trigger, status: "active" }),
    ).rejects.toThrow();
  });

  it("dois /start do mesmo lead continuam com UMA linha de progresso (upsert, não insert cego)", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Oi" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(9102) });
    await useCase.execute({ botId: bot.id, update: startUpdate(9102) });

    const db = await testDb();
    const [lead] = await db.select().from(leads).where(eq(leads.telegramChatId, 9102n));
    const rows = await db.select().from(leadProgress).where(eq(leadProgress.leadId, lead.id));
    expect(rows).toHaveLength(1);
  });
});

describe("Achado 2 — escopo da limpeza de scheduled_delays", () => {
  it("comprar a oferta A não cancela o timeout de 'sem ação' da oferta B (mesmo nó)", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const offerA = { gateway_id: gwId, product_name: "A", price: 10, callback: "prod_a", button_text: "Comprar A" };
    const offerB = { gateway_id: gwId, product_name: "B", price: 20, callback: "prod_b", button_text: "Comprar B" };
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers: [offerA, offerB], unpaid_timeout: 5 } },
        { key: "pendingA", type: "message", content: { message: "A-PENDENTE" } },
        { key: "pendingB", type: "message", content: { message: "B-PENDENTE" } },
      ],
      connections: [
        { from: "t", to: "off" },
        { from: "off", to: "pendingA", handle: "prod_a__pending" },
        { from: "off", to: "pendingB", handle: "prod_b__pending" },
      ],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(9201) });
    const db = await testDb();
    const beforeClick = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    expect(beforeClick).toHaveLength(2); // "sem ação" de A e de B, cada uma pro seu próprio destino

    // Compra a oferta A (índice 0 no array `offers`).
    await useCase.execute({ botId: bot.id, update: callbackUpdate(9201, "offer:0") });

    const afterClick = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    // A de A virou "não pago" (mesmo destino __pending); a de B TEM que
    // continuar viva — antes desta correção, apagar por progressId inteiro
    // cancelava as duas.
    expect(afterClick).toHaveLength(2);
    expect(afterClick.some((d) => d.nextNodeId === nodeIds.pendingB)).toBe(true);
  });

  // Regressão [ALTA] apontada na revisão do PR: em handlePaidOffer o lead SAI
  // do nó (avança ou completa) — diferente de handleOfferPurchase, onde ele
  // continua no mesmo nó. Se a limpeza ali continuasse escopada só pelo alvo
  // da PRÓPRIA oferta, o timeout de um downsell já em curso (agendado por um
  // "sem ação"/"não pago" anterior) sobreviveria e dispararia depois pra quem
  // JÁ PAGOU.
  it("pagar a oferta A cancela o timeout do downsell D2 já agendado (não é escopado por alvo aqui)", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const offerA = {
      gateway_id: gwId, product_name: "A", price: 10, callback: "a", button_text: "Comprar A",
      product_type: "content", delivery_url: "https://entrega-a",
    };
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers: [offerA], unpaid_timeout: 5 } },
        // Downsell: nó de delay que, ao rodar, agenda D2 — é o "downsell D
        // agenda D2" do cenário da revisão.
        { key: "d", type: "delay", content: { seconds: 600 } },
        { key: "d2", type: "message", content: { message: "DOWNSELL-CHEGOU" } },
      ],
      connections: [
        { from: "t", to: "off" },
        { from: "off", to: "d", handle: "a__pending" },
        { from: "d", to: "d2" },
      ],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(9210) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(9210, "offer:0") });

    const db = await testDb();
    // PIX de A não pago: vence o timeout "não pago" (__pending → nó "d") —
    // força o vencimento em vez de esperar de verdade, igual delays-queue.test.
    await db.update(scheduledDelays).set({ executeAt: new Date(Date.now() - 1000) });
    await processPendingDelays();

    // "d" rodou (nó `delay`) e agendou D2 — downsell em curso.
    const afterTimeout = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    expect(afterTimeout).toHaveLength(1);
    expect(afterTimeout[0].nextNodeId).toBe(nodeIds.d2);

    // Lead paga A (o pagamento referencia o nó "off"/handle "a", não "d") —
    // handlePaidOffer entrega e sai do nó "off". O timeout de D2 (agendado
    // por um nó totalmente diferente) TEM que morrer junto.
    const [pay] = await db.select().from(payments);
    await useCase.handlePaidOffer((await payRepo.findById(pay.id))!);

    const afterPaid = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    expect(afterPaid).toHaveLength(0); // D2 NÃO pode disparar pra quem já pagou
  });
});

describe("Achado 3 — beco sem saída silencioso", () => {
  it("clique num botão sem aresta (identificado com certeza, formato atual com escopo de nó) marca o progresso com o motivo", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        // "orfao" tem callback mas NENHUMA conexão de saída ligada a ele —
        // um beco sem saída real (não um teclado antigo).
        { key: "btn", type: "buttons", content: { message: "Escolha:", buttons: [{ text: "Órfão", callback: "orfao" }] } },
      ],
      connections: [{ from: "t", to: "btn" }],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(9301) });

    // O callback_data de fato ENVIADO pro Telegram é o formato ATUAL, com
    // escopo de nó (`b:<nó>:<i>`) — não o handle cru ("orfao"). Extrai da
    // keyboard presentada, igual os demais testes de escopo reverso.
    const kb = getTelegramCalls("sendMessage")[0].body.reply_markup as { inline_keyboard: { callback_data?: string }[][] };
    const scopedCallback = kb.inline_keyboard[0][0].callback_data!;
    expect(scopedCallback).toMatch(/^b:[a-z0-9]{1,8}:0$/);

    await useCase.execute({ botId: bot.id, update: callbackUpdate(9301, scopedCallback) });

    const db = await testDb();
    const [lead] = await db.select().from(leads).where(eq(leads.telegramChatId, 9301n));
    const [prog] = await db.select().from(leadProgress).where(eq(leadProgress.leadId, lead.id));
    expect(prog.stallReason).toBe("botao_sem_conexao");
  });

  it("clique com o handle LITERAL (formato legado, sem escopo de nó) NÃO marca — ambíguo com um teclado antigo de outro nó", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "btn", type: "buttons", content: { message: "Escolha:", buttons: [{ text: "Órfão", callback: "orfao" }] } },
      ],
      connections: [{ from: "t", to: "btn" }],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(9302) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(9302, "orfao") });

    const db = await testDb();
    const [lead] = await db.select().from(leads).where(eq(leads.telegramChatId, 9302n));
    const [prog] = await db.select().from(leadProgress).where(eq(leadProgress.leadId, lead.id));
    expect(prog.stallReason).toBeNull();
  });
});

describe("Achado 4 — falha ao gerar PIX não deixa o lead sem timeout", () => {
  it("gateway falhando preserva o timeout de 'sem ação' já agendado (a limpeza só acontece depois do PIX criado)", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const offer = { gateway_id: gwId, product_name: "Curso", price: 19.9, callback: "promo", button_text: "Comprar" };
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers: [offer], unpaid_timeout: 5 } },
        { key: "pending", type: "message", content: { message: "SEM-PIX" } },
      ],
      connections: [
        { from: "t", to: "off" },
        { from: "off", to: "pending", handle: "promo__pending" },
      ],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(9401) });
    forceGatewayError("realtechdev"); // buckpay fora do ar

    await useCase.execute({ botId: bot.id, update: callbackUpdate(9401, "offer:0") });

    expect(getSentMessages().some((m) => m.includes("Não consegui gerar o PIX"))).toBe(true);

    const db = await testDb();
    const pending = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    expect(pending).toHaveLength(1); // reagendado — não some sem deixar rastro
    expect(pending[0].nextNodeId).toBe(nodeIds.pending);
  });
});

describe("Achado 2 (handleOfferPurchase) — não duplica o __pending num re-clique", () => {
  // [MÉDIA] apontado na revisão: apagar só UM alvo (`??`) entre __no_action e
  // __pending deixava o outro vivo. Com os dois wired pra nós DIFERENTES, um
  // re-clique depois do PIX expirar reagendava o "não pago" sem cancelar o
  // "não pago" da rodada anterior — duas linhas pro MESMO destino __pending.
  it("PIX expirado + segundo clique: só 1 delay 'não pago' no final, não 2", async () => {
    const handle = "promo";
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const offer = { gateway_id: gwId, product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" };
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers: [offer], unpaid_timeout: 1 } },
        { key: "noact", type: "message", content: { message: "SEM-ACAO" } },
        { key: "pending", type: "message", content: { message: "NAO-PAGO" } },
      ],
      connections: [
        { from: "t", to: "off" },
        { from: "off", to: "noact", handle: `${handle}__no_action` },
        { from: "off", to: "pending", handle: `${handle}__pending` },
      ],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(9220) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(9220, "offer:0") }); // 1º clique: gera PIX #1

    const db = await testDb();
    const first = (await db.select().from(payments))[0];
    // Envelhece o pendente além do teto (unpaid_timeout=1min) — simula PIX
    // morto no gateway, igual o teste de teto de idade de flow-offers.test.ts.
    await db.update(payments).set({ createdAt: new Date(Date.now() - 2 * 60_000) }).where(eq(payments.id, first.id));

    await useCase.execute({ botId: bot.id, update: callbackUpdate(9220, "offer:0") }); // 2º clique: gera PIX #2

    const pendingDelays = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    expect(pendingDelays).toHaveLength(1); // não 2 — o "não pago" do 1º clique foi cancelado
    expect(pendingDelays[0].nextNodeId).toBe(nodeIds.pending);
  });
});

// Achado 5 (escape de HTML nos templates customizados de PIX) é resolvido no
// PR #64, dentro de `replacePixVariables` — ver pix-messages.test.ts. Este
// branch propositalmente não escapa `pixVars` (ver comentário em
// pix-messages.ts) pra não dobrar a entidade quando os dois PRs se juntarem.
