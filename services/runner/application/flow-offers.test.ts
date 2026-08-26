import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ExecuteFlowStepUseCase, collectNodeOffers } from "./execute-flow-step.use-case.js";
import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { processPendingDelays } from "../runner.js";
import { testDb } from "../../../test/helpers/db.js";
import { payments, scheduledDelays, leads, funnelOffers, funnelNodes } from "../../shared/schema/index.js";
import {
  createBot, createGateway, createFlowFunnel, startUpdate, callbackUpdate,
} from "../../../test/helpers/seed.js";
import { getSentMessages, getTelegramCalls } from "../../../test/helpers/fetch-mock.js";

const useCase = new ExecuteFlowStepUseCase();
const payRepo = new PaymentDrizzleRepository();

async function setupOffer(opts: { offer: Record<string, unknown>; extraConns?: Array<{ from: string; to: string; handle: string }>; unpaidTimeout?: number }) {
  const bot = await createBot();
  const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
  const offer = { gateway_id: gwId, ...opts.offer };
  const { funnelId, nodeIds } = await createFlowFunnel({
    userId: bot.userId, botId: bot.id,
    nodes: [
      { key: "t", type: "trigger" },
      { key: "off", type: "offer", content: { offers: [offer], unpaid_timeout: opts.unpaidTimeout ?? 5 } },
      { key: "paid", type: "message", content: { message: "ACESSO-LIBERADO" } },
      { key: "pending", type: "message", content: { message: "AINDA-PENDENTE" } },
      { key: "noact", type: "message", content: { message: "NAO-CLICOU" } },
    ],
    connections: [
      { from: "t", to: "off" },
      ...(opts.extraConns ?? []),
    ],
  });
  return { bot, gwId, funnelId, nodeIds, offer };
}

describe("offer node — apresentação e compra", () => {
  // "Sem ação" (nunca clicou) tem handle PRÓPRIO (__no_action) de novo — a UI
  // voltou a expor as duas linhas/conexões por oferta (OfferNode.tsx). Um
  // funil salvo ANTES dessa correção (commit e8657f94 migrou os dados de
  // produção trocando __no_action por __pending) só tem a conexão __pending —
  // por isso `scheduleOfferTimeouts` tenta __no_action primeiro e cai pra
  // __pending quando não encontra aresta com esse handle. Este teste cobre
  // justamente o funil "antigo" (só __pending salvo).
  it("apresenta botão de compra offer:0 e agenda o timeout de sem ação via __pending (funil antigo, sem __no_action salvo)", async () => {
    const handle = "promo";
    const { bot, nodeIds } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" },
      extraConns: [{ from: "off", to: "pending", handle: `${handle}__pending` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(700) });
    const presented = getTelegramCalls().find((c) => c.body.reply_markup);
    const kb = (presented!.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
    // callback_data agora carrega a identidade do nó (o:<nodeId8>:<i>), pra um
    // teclado antigo lá em cima da conversa não conseguir mexer no nó atual.
    // O formato legado "offer:0" continua sendo aceito na entrada.
    expect(kb[0][0].callback_data).toMatch(/^o:[a-z0-9]{1,8}:0$/);

    const db = await testDb();
    const delays = await db.select().from(scheduledDelays);
    expect(delays.length).toBe(1); // timeout de "sem ação" agendado, via fallback __pending
    expect(delays[0].nextNodeId).toBe(nodeIds.pending);
  });

  it("com __no_action e __pending conectados, o timeout de sem ação usa __no_action (handle próprio tem prioridade)", async () => {
    const handle = "promo";
    const { bot, nodeIds } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" },
      extraConns: [
        { from: "off", to: "noact", handle: `${handle}__no_action` },
        { from: "off", to: "pending", handle: `${handle}__pending` },
      ],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(706) });

    const db = await testDb();
    const delays = await db.select().from(scheduledDelays);
    expect(delays.length).toBe(1);
    expect(delays[0].nextNodeId).toBe(nodeIds.noact); // __no_action, não __pending
  });

  it("clique gera PIX em CENTAVOS, persiste payment e envia QR + copia-e-cola", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar", product_type: "content", delivery_url: "https://entrega" },
      extraConns: [{ from: "off", to: "paid", handle: `${handle}__paid` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(701) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(701, "offer:0") });

    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay).toBeDefined();
    expect(pay.amount).toBe(1990);               // 19.90 reais → 1990 centavos
    expect(pay.status).toBe("pending");
    expect(pay.paidHandle).toBe(`${handle}__paid`);
    expect(pay.pixCode).toBeTruthy();

    // QR (sendPhoto) + copia-e-cola (sendMessage com <code>)
    expect(getTelegramCalls("sendPhoto").length).toBeGreaterThan(0);
    expect(getSentMessages().some((m) => m.includes("<code>"))).toBe(true);
  });

  it("delay de 'sem ação' é cancelado ao clicar e substituído por um novo delay de 'não pago' (mesmo destino __pending)", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 30, callback: handle, button_text: "Comprar" },
      extraConns: [{ from: "off", to: "pending", handle: `${handle}__pending` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(702) });
    const db = await testDb();
    const beforeClick = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    expect(beforeClick.length).toBe(1); // delay de "sem ação" agendado na apresentação
    const firstDelayId = beforeClick[0].id;

    await useCase.execute({ botId: bot.id, update: callbackUpdate(702, "offer:0") });
    const afterClick = await db.select().from(scheduledDelays).where(eq(scheduledDelays.status, "pending"));
    // continua só 1 (mesmo destino __pending), mas é OUTRA linha — a de "sem
    // ação" foi apagada no clique e uma nova de "não pago" tomou o lugar.
    expect(afterClick.length).toBe(1);
    expect(afterClick[0].id).not.toBe(firstDelayId);
  });
});

// Incidente real de produção: um nó com N ofertas cujos handles __pending
// apontavam TODAS pro mesmo nó de downsell inseria N linhas idênticas em
// scheduled_delays; o worker reexecutava o destino uma vez por linha e, como
// esse destino também tinha ofertas, cada execução agendava mais N — fan-out
// exponencial (3^k por ciclo) até ~700+ mensagens/hora pra um único lead.
describe("scheduleOfferTimeouts — dedupe por destino (fan-out exponencial)", () => {
  it("3 ofertas cujo __pending aponta pro MESMO destino agendam só 1 delay (dedupe por destino, não por oferta)", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const offers = ["a", "b", "c"].map((h) => ({
      gateway_id: gwId, product_name: `Plano ${h}`, price: 19.9, callback: h, button_text: "Comprar",
    }));
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers, unpaid_timeout: 5 } },
        { key: "downsell", type: "message", content: { message: "DOWNSELL-UNICO" } },
      ],
      connections: [
        { from: "t", to: "off" },
        { from: "off", to: "downsell", handle: "a__pending" },
        { from: "off", to: "downsell", handle: "b__pending" },
        { from: "off", to: "downsell", handle: "c__pending" },
      ],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(710) });

    const db = await testDb();
    const delays = await db.select().from(scheduledDelays);
    expect(delays.length).toBe(1); // não 3 — dedupe pelo mesmo nextNodeId
    expect(delays[0].nextNodeId).toBe(nodeIds.downsell);
  });

  it("3 ofertas com destinos DIFERENTES continuam agendando 3 delays (dedupe não é agressivo demais)", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const offers = ["a", "b", "c"].map((h) => ({
      gateway_id: gwId, product_name: `Plano ${h}`, price: 19.9, callback: h, button_text: "Comprar",
    }));
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers, unpaid_timeout: 5 } },
        { key: "downsellA", type: "message", content: { message: "DOWNSELL-A" } },
        { key: "downsellB", type: "message", content: { message: "DOWNSELL-B" } },
        { key: "downsellC", type: "message", content: { message: "DOWNSELL-C" } },
      ],
      connections: [
        { from: "t", to: "off" },
        { from: "off", to: "downsellA", handle: "a__pending" },
        { from: "off", to: "downsellB", handle: "b__pending" },
        { from: "off", to: "downsellC", handle: "c__pending" },
      ],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(711) });

    const db = await testDb();
    const delays = await db.select().from(scheduledDelays);
    const targets = delays.map((d) => d.nextNodeId).sort();
    expect(targets).toEqual([nodeIds.downsellA, nodeIds.downsellB, nodeIds.downsellC].sort());
  });
});

// Resolução reversa de escopo: o clique num botão de OFERTA antigo (teclado já
// entregue antes de o timeout "sem ação" mover o lead pra outro nó) deve
// resolver contra o nó de ORIGEM (achado pelo escopo embutido no callback), em
// vez de ser descartado como "foreign" — é o bug do backlog ("botões antigos
// param de funcionar e o lead fica preso").
describe("escopo reverso — clique em oferta ANTIGA depois do timeout", () => {
  it("clique numa oferta antiga depois do timeout 'sem ação' gera o PIX correto da oferta antiga", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" },
      extraConns: [{ from: "off", to: "noact", handle: `${handle}__pending` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(730) });
    const presented = getTelegramCalls().find((c) => c.body.reply_markup);
    const kb = (presented!.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
    const oldCallback = kb[0][0].callback_data!;

    // Vence o timeout de "sem ação" ANTES do clique chegar — o lead é movido pro
    // nó "noact" (exatamente o cenário do bug: o clique no teclado antigo chega
    // depois de o current_node_id já ter mudado).
    const db = await testDb();
    await db.update(scheduledDelays).set({ executeAt: new Date(Date.now() - 1000) });
    await processPendingDelays();
    expect(getSentMessages()).toContain("NAO-CLICOU");

    await useCase.execute({ botId: bot.id, update: callbackUpdate(730, oldCallback) });

    const [pay] = await db.select().from(payments);
    expect(pay).toBeDefined();
    expect(pay.amount).toBe(1990);               // 19.90 reais → 1990 centavos (produto certo)
    expect(pay.paidHandle).toBe(`${handle}__paid`);
    expect(pay.pixCode).toBeTruthy();
    expect(getTelegramCalls("sendPhoto").length).toBeGreaterThan(0);
  });

  it("re-clique no mesmo botão de oferta antigo não duplica o PIX", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" },
      extraConns: [{ from: "off", to: "noact", handle: `${handle}__pending` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(731) });
    const presented = getTelegramCalls().find((c) => c.body.reply_markup);
    const kb = (presented!.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
    const oldCallback = kb[0][0].callback_data!;

    const db = await testDb();
    await db.update(scheduledDelays).set({ executeAt: new Date(Date.now() - 1000) });
    await processPendingDelays();

    await useCase.execute({ botId: bot.id, update: callbackUpdate(731, oldCallback) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(731, oldCallback) }); // re-clique

    const rows = await db.select().from(payments);
    expect(rows.length).toBe(1);                          // um único pagamento
    expect(getTelegramCalls("sendPhoto").length).toBe(1);  // só o 1º clique gerou QR novo
  });

  it("escopo ambíguo (colisão de prefixo de 8 chars) é ignorado, sem crash", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    const { funnelId, nodeIds } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers: [
          { product_name: "X", price: 10, gateway_id: gwId, callback: "promo", button_text: "Comprar" },
        ] } },
      ],
      connections: [{ from: "t", to: "off" }],
    });
    const db = await testDb();
    // Segundo nó com o MESMO escopo de 8 chars do nó "off" — colisão forçada
    // (uuids aleatórios colidindo nos 8 primeiros chars é raríssimo na prática,
    // mas a resolução reversa tem que aguentar sem escolher "o primeiro que bater").
    const scope = nodeIds.off.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    await db.insert(funnelNodes).values({
      id: `${scope}-9999-4999-8999-999999999999`,
      funnelId, type: "message", content: { message: "OUTRO" },
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(732) });
    const kb = (getTelegramCalls().find((c) => c.body.reply_markup)!.body.reply_markup as {
      inline_keyboard: { callback_data?: string }[][];
    }).inline_keyboard;
    const cb = kb[0][0].callback_data!;

    // Sai do nó "off" pra forçar a resolução reversa (senão o escopo bateria
    // direto com o nó atual, sem passar pela busca ambígua).
    const { leadProgress } = await import("../../shared/schema/index.js");
    await db.update(leadProgress).set({ currentNodeId: nodeIds.t });

    await expect(useCase.execute({ botId: bot.id, update: callbackUpdate(732, cb) })).resolves.not.toThrow();
    const rows = await db.select().from(payments);
    expect(rows.length).toBe(0); // ambíguo → ignorado, nenhum PIX gerado
  });

  it("callback de escopo de OUTRO funil é ignorado (segurança)", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    // Funil A (inativo): só pra mintar um escopo de nó que pertence a OUTRO funil.
    const { nodeIds: nodeIdsA } = await createFlowFunnel({
      userId: bot.userId, botId: bot.id, isActive: false,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "off", type: "offer", content: { offers: [
          { product_name: "Outro", price: 5, gateway_id: gwId, callback: "x", button_text: "Comprar" },
        ] } },
      ],
      connections: [{ from: "t", to: "off" }],
    });
    const scopeA = nodeIdsA.off.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);

    // Funil B (ativo): onde o lead realmente está.
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { message: "OI" } },
      ],
      connections: [{ from: "t", to: "m" }],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(733) });
    expect(getSentMessages()).toContain("OI");

    await useCase.execute({ botId: bot.id, update: callbackUpdate(733, `o:${scopeA}:0`) });

    const db = await testDb();
    const rows = await db.select().from(payments);
    expect(rows.length).toBe(0);
  });
});

// Achados [Medium] da revisão de segurança/reviewer sobre a branch de escopo
// reverso: (1) handleOfferPurchase fazia check-then-act (findPendingForOffer →
// createPixWithFallback → payRepo.create) sem lock nem transação — dois
// cliques concorrentes liam "sem pendente" antes de qualquer um inserir e
// geravam dois PIX; corrigido com o índice único parcial
// `payments_pending_offer_unique` (migration 0014) + captura da violação no
// INSERT. (2) findPendingForOffer não tinha teto de idade — um PIX morto no
// gateway (sem o webhook de expiração ter chegado) seria reenviado pro lead
// pra sempre; corrigido reaproveitando o `unpaid_timeout` do nó como teto.
describe("PIX pendente — teto de idade e corrida de INSERT (revisão de segurança)", () => {
  it("PIX pendente mais velho que o timeout 'não pago' do nó é ignorado — gera um PIX novo", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" },
      unpaidTimeout: 1, // minuto — só define o teto que envelhecemos manualmente abaixo
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(740) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(740, "offer:0") });

    const db = await testDb();
    const first = (await db.select().from(payments))[0];
    expect(first.status).toBe("pending");

    // Envelhece o pendente além do teto de 1 minuto (unpaid_timeout do nó) —
    // simula um PIX morto no gateway sem o webhook de expiração ter chegado.
    await db.update(payments)
      .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(payments.id, first.id));

    await useCase.execute({ botId: bot.id, update: callbackUpdate(740, "offer:0") });

    const rows = await db.select().from(payments).orderBy(payments.createdAt);
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].status).toBe("expired");   // expirado localmente, libera a constraint única
    expect(rows[1].status).toBe("pending");   // PIX novo, de fato gerado
    expect(rows[1].id).not.toBe(first.id);
    expect(getTelegramCalls("sendPhoto").length).toBe(2); // dois PIX gerados de verdade (1 por clique)
  });

  // Reproduzir a corrida de verdade (duas execuções concorrentes de verdade)
  // não dá em um teste unitário sequencial — este teste SIMULA a corrida
  // mockando findPendingForOffer pra devolver "nada pendente" na 1ª chamada
  // (o instante em que a execução perdedora fez sua leitura, ANTES de a
  // vencedora commitar o INSERT dela) enquanto o pendente da vencedora já está
  // no banco. O INSERT desta execução deve então bater na constraint única
  // (payments_pending_offer_unique) e cair no catch, sem propagar erro nem
  // duplicar a linha.
  it("[simulação] violação da constraint única no INSERT concorrente reenvia o PIX da vencedora, sem erro pro lead", async () => {
    const handle = "promo";
    const { bot, gwId, nodeIds } = await setupOffer({
      offer: { product_name: "Curso", price: 19.9, callback: handle, button_text: "Comprar" },
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(741) });

    const db = await testDb();
    const [lead] = await db.select().from(leads).where(eq(leads.telegramChatId, 741n));

    // "Vencedora" da corrida: já inseriu o pendente pra este lead/nó/handle
    // ANTES de esta execução alcançar o INSERT dela.
    const winner = await payRepo.create({
      userId: bot.userId, botId: bot.id, gatewayId: gwId, leadId: lead.id,
      nodeId: nodeIds.off, paidHandle: `${handle}__paid`,
      amount: 1990, offerName: "Curso", pixCode: "WINNER-PIX-CODE",
    });

    // Mock só na 1ª chamada: simula a leitura desta execução (perdedora) ANTES
    // do INSERT da vencedora ficar visível. A 2ª chamada (dentro do catch, já
    // depois da constraint barrar) usa a implementação real e enxerga a
    // vencedora normalmente.
    const spy = vi.spyOn(PaymentDrizzleRepository.prototype, "findPendingForOffer")
      .mockImplementationOnce(async () => null);
    try {
      await expect(
        useCase.execute({ botId: bot.id, update: callbackUpdate(741, "offer:0") }),
      ).resolves.not.toThrow();
    } finally {
      spy.mockRestore();
    }

    const rows = await db.select().from(payments);
    expect(rows.length).toBe(1);          // o INSERT desta execução foi barrado pela constraint — sem duplicata
    expect(rows[0].id).toBe(winner.id);   // só a linha da vencedora existe
    expect(getSentMessages().some((m) => m.includes("WINNER-PIX-CODE"))).toBe(true); // reenviou o PIX dela
  });
});

describe("handlePaidOffer — entrega e retomada", () => {
  // Cenário do funil "Mica": o usuário liga a continuação pós-pagamento na
  // saída GENÉRICA do nó de oferta (sem handle), não no handle __paid. Antes
  // essa aresta era morta: entregava o "Pagamento confirmado" e o funil parava.
  it("sem conexão __paid, retoma pela saída genérica (source_handle null)", async () => {
    const { bot, funnelId, nodeIds } = await setupOffer({
      // Sem callback → handle = product_name (como no funil exportado do usuário).
      offer: { product_name: "Vem me ver pelada", price: 9.9, button_text: "Comprar", product_type: "content" },
    });
    // Conexão genérica off → paid (from/to sem handle).
    const db = await testDb();
    const { nodeConnections } = await import("../../shared/schema/index.js");
    await db.insert(nodeConnections).values({
      funnelId, sourceNodeId: nodeIds.off, sourceHandle: null, targetNodeId: nodeIds.paid,
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(720) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(720, "offer:0") });

    const [pay] = await db.select().from(payments);
    expect(pay.paidHandle).toBe("Vem me ver pelada__paid");
    await useCase.handlePaidOffer((await payRepo.findById(pay.id))!);

    const msgs = getSentMessages();
    expect(msgs.some((m) => m.includes("Pagamento confirmado"))).toBe(true);
    expect(msgs).toContain("ACESSO-LIBERADO"); // continuou pela saída genérica
  });

  it("com __paid E saída genérica, o __paid tem prioridade", async () => {
    const handle = "promo";
    const { bot, funnelId, nodeIds } = await setupOffer({
      offer: { product_name: "Curso", price: 50, callback: handle, button_text: "Comprar" },
      extraConns: [{ from: "off", to: "paid", handle: `${handle}__paid` }],
    });
    const db = await testDb();
    const { nodeConnections } = await import("../../shared/schema/index.js");
    // Saída genérica apontando pro nó "errado" (noact) — não pode ser usada.
    await db.insert(nodeConnections).values({
      funnelId, sourceNodeId: nodeIds.off, sourceHandle: null, targetNodeId: nodeIds.noact,
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(721) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(721, "offer:0") });
    const [pay] = await db.select().from(payments);
    await useCase.handlePaidOffer((await payRepo.findById(pay.id))!);

    const msgs = getSentMessages();
    expect(msgs).toContain("ACESSO-LIBERADO");      // seguiu o __paid
    expect(msgs).not.toContain("NAO-CLICOU");       // ignorou a genérica
  });

  it("entrega conteúdo e retoma pelo ramo __paid", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
      offer: { product_name: "Curso", price: 50, callback: handle, button_text: "Comprar", product_type: "content", delivery_url: "https://meu-produto" },
      extraConns: [{ from: "off", to: "paid", handle: `${handle}__paid` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(703) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(703, "offer:0") });

    const db = await testDb();
    const [pay] = await db.select().from(payments);
    const payment = await payRepo.findById(pay.id);
    await useCase.handlePaidOffer(payment!);

    const msgs = getSentMessages();
    expect(msgs.some((m) => m.includes("meu-produto"))).toBe(true); // entrega
    expect(msgs).toContain("ACESSO-LIBERADO");                       // retomou __paid
  });

  it("entrega VIP gera convite via createChatInviteLink", async () => {
    const handle = "vip";
    const { bot } = await setupOffer({
      offer: { product_name: "Grupo VIP", price: 99, callback: handle, button_text: "Entrar", product_type: "vip_group", telegram_group_id: "-100123", access_days: 30 },
      extraConns: [{ from: "off", to: "paid", handle: `${handle}__paid` }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(704) });
    await useCase.execute({ botId: bot.id, update: callbackUpdate(704, "offer:0") });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    await useCase.handlePaidOffer((await payRepo.findById(pay.id))!);

    expect(getTelegramCalls("createChatInviteLink").length).toBe(1);
    // O link de convite agora vai num BOTÃO (reply_markup), não colado no texto.
    const withButton = getTelegramCalls("sendMessage").find((c) => {
      const kb = (c.body.reply_markup as { inline_keyboard?: Array<Array<{ url?: string }>> })?.inline_keyboard;
      return kb?.some((row) => row.some((b) => b.url?.includes("t.me/+testinvite")));
    });
    expect(withButton).toBeDefined();
    // e o link não deve mais aparecer cru no texto de nenhuma mensagem
    expect(getSentMessages().some((m) => m.includes("t.me/+testinvite"))).toBe(false);
  });
});

describe("ofertas embutidas em nó message (block.type=offer)", () => {
  it("apresenta botão e processa compra com handle do bloco", async () => {
    const bot = await createBot();
    const gwId = await createGateway({ userId: bot.userId, provider: "buckpay" });
    await createFlowFunnel({
      userId: bot.userId, botId: bot.id,
      nodes: [
        { key: "t", type: "trigger" },
        { key: "m", type: "message", content: { blocks: [
          { type: "text", message: "Veja a oferta" },
          { type: "offer", offers: [{ product_name: "X", price: 10, gateway_id: gwId, callback: "blk", button_text: "Quero" }] },
        ] } },
      ],
      connections: [{ from: "t", to: "m" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(705) });
    const presented = getTelegramCalls().find((c) => c.body.reply_markup);
    expect(presented).toBeDefined();
    await useCase.execute({ botId: bot.id, update: callbackUpdate(705, "offer:0") });
    const db = await testDb();
    const [pay] = await db.select().from(payments);
    expect(pay.amount).toBe(1000);
  });
});

// Bug do backlog: duas ofertas do mesmo nó com o mesmo callback/product_name
// (ou ambos vazios) derivavam o MESMO handleId — o editor só deixava conectar
// uma das duas. collectNodeOffers precisa desempatar exatamente como
// OfferNode.tsx: 1ª ocorrência usa a base direto, ocorrências seguintes
// ganham sufixo `#2`, `#3`...
describe("collectNodeOffers — desempate de handleId entre ofertas do mesmo nó", () => {
  it("callbacks iguais: a 2ª ocorrência ganha sufixo #2", () => {
    const list = collectNodeOffers({
      offers: [
        { product_name: "Curso A", callback: "promo" },
        { product_name: "Curso B", callback: "promo" },
      ],
    });
    expect(list.map((o) => o.handleId)).toEqual(["promo", "promo#2"]);
  });

  it("nomes iguais (sem callback): a 2ª ocorrência ganha sufixo #2", () => {
    const list = collectNodeOffers({
      offers: [
        { product_name: "Curso" },
        { product_name: "Curso" },
      ],
    });
    expect(list.map((o) => o.handleId)).toEqual(["Curso", "Curso#2"]);
  });

  it("ambos vazios: cai no fallback offer_<i>, já único por índice — sem sufixo", () => {
    const list = collectNodeOffers({
      offers: [{}, {}],
    });
    expect(list.map((o) => o.handleId)).toEqual(["offer_0", "offer_1"]);
  });

  it("mistura vazio/preenchido: só as bases realmente repetidas ganham sufixo", () => {
    const list = collectNodeOffers({
      offers: [
        { callback: "promo" },     // "promo"
        {},                        // "offer_1" (fallback por índice, não colide)
        { product_name: "promo" }, // "promo" de novo → repetida
      ],
    });
    expect(list.map((o) => o.handleId)).toEqual(["promo", "offer_1", "promo#2"]);
  });

  it("3+ ofertas com a mesma base: sufixos incrementam #2, #3, #4", () => {
    const list = collectNodeOffers({
      offers: [
        { callback: "vip" },
        { callback: "vip" },
        { callback: "vip" },
        { callback: "vip" },
      ],
    });
    expect(list.map((o) => o.handleId)).toEqual(["vip", "vip#2", "vip#3", "vip#4"]);
  });

  it("preserva a ordem do array `offers` (mesma ordem que offers.map usa no frontend)", () => {
    const list = collectNodeOffers({
      offers: [
        { callback: "z" },
        { callback: "a" },
        { callback: "m" },
      ],
    });
    expect(list.map((o) => o.handleId)).toEqual(["z", "a", "m"]);
  });

  // Achado da auditoria de segurança: contar ocorrências só da BASE ("promo")
  // deixava passar uma colisão de 2ª ordem. A: "promo" → id "promo". B: "promo"
  // duplicada → auto-sufixo "promo#2". C: callback LITERAL "promo#2"
  // (coincidência, ou alguém digitou isso sem saber do algoritmo interno) —
  // contando por base, C seria "1ª ocorrência da base 'promo#2'" e ganharia o
  // MESMO id já dado a B. Duas ofertas diferentes com o mesmo handleId é
  // exatamente o bug que a dedupe existe pra evitar — handlePaidOffer resolve
  // a oferta a entregar por `.find()` no array (pega a PRIMEIRA que bater), e
  // quem pagasse por C receberia a entrega configurada pra B. O algoritmo
  // correto verifica contra TODOS os ids já atribuídos (literais ou gerados),
  // não só contra a base, e incrementa o sufixo até achar um livre.
  it("callback literal igual ao sufixo auto-gerado não colide com a oferta que gerou esse sufixo", () => {
    const list = collectNodeOffers({
      offers: [
        { product_name: "A", callback: "promo" },      // "promo"
        { product_name: "B", callback: "promo" },       // "promo" repetida → "promo#2"
        { product_name: "C", callback: "promo#2" },     // literal igual ao sufixo de B
      ],
    });
    const ids = list.map((o) => o.handleId);
    expect(ids).toEqual(["promo", "promo#2", "promo#2#2"]);
    expect(new Set(ids).size).toBe(3); // nenhum handleId repetido entre ofertas diferentes

    // A oferta certa continua recuperável por handleId (é o que handlePaidOffer
    // usa pra decidir o que entregar quando o pagamento confirma).
    expect(list.find((o) => o.handleId === "promo#2")?.offer.product_name).toBe("B");
    expect(list.find((o) => o.handleId === "promo#2#2")?.offer.product_name).toBe("C");
  });
});

describe("bcast_buy — compra de oferta avulsa (broadcast/remarketing)", () => {
  it("clique no botão bcast_buy gera PIX no valor da oferta e persiste payment", async () => {
    const bot = await createBot();
    await createGateway({ userId: bot.userId, provider: "buckpay" });
    const db = await testDb();
    const [offer] = await db.insert(funnelOffers).values({ botId: bot.id, name: "Curso", price: 1990, productType: "content", deliveryUrl: "https://entrega" }).returning();
    await useCase.execute({ botId: bot.id, update: callbackUpdate(7200, `bcast_buy_${offer.id}`) });
    const [pay] = await db.select().from(payments);
    expect(pay).toBeDefined();
    expect(pay.amount).toBe(1990);
    expect(pay.offerId).toBe(offer.id);
    expect(getTelegramCalls("sendPhoto").length).toBeGreaterThan(0);
    expect(getSentMessages().some((m) => m.includes("<code>"))).toBe(true);
  });
});
