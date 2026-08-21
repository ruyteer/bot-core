import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
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
  // "Sem ação" (nunca clicou) e "Não pago" (clicou, não pagou) saem pelo MESMO
  // handle __pending hoje — a UI só expõe uma linha/conexão por oferta
  // (OfferNode.tsx). O que muda entre os dois casos é só a duração do timeout
  // (no_action_timeout vs unpaid_timeout), não o destino.
  it("apresenta botão de compra offer:0 e agenda o timeout de sem ação via __pending", async () => {
    const handle = "promo";
    const { bot } = await setupOffer({
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
    expect(delays.length).toBe(1); // timeout de "sem ação" agendado pro handle __pending
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
