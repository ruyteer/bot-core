// Cobre a validação "nome + preço + entrega" na criação de ofertas — regra do
// item de backlog "validação de oferta antes de salvar". Testa os handlers
// REAIS de funnels.api.ts (createOffer/createOffersBulk), não só o validador
// isolado, para garantir que os endpoints realmente chamam a checagem.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { funnelOffers } from "../shared/schema/index.js";
import { createBot } from "../../test/helpers/seed.js";
import { assertOfferComplete } from "./domain/offer-validation.js";
import { FunnelDrizzleRepository } from "./infrastructure/funnel.drizzle.repository.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { createOffer, createOffersBulk, saveFlow, activate, update } = await import("./funnels.api.js");
const repo = new FunnelDrizzleRepository();

describe("assertOfferComplete", () => {
  it("aceita oferta com nome, preço > 0 e ao menos um campo de entrega", () => {
    expect(() => assertOfferComplete({ name: "Produto", price: 1000, deliveryUrl: "https://x.com" })).not.toThrow();
    expect(() => assertOfferComplete({ name: "Produto", price: 1000, deliveryText: "acesse assim" })).not.toThrow();
    expect(() => assertOfferComplete({ name: "Produto", price: 1000, telegramGroupId: crypto.randomUUID() })).not.toThrow();
  });

  it("rejeita nome vazio/ausente", () => {
    expect(() => assertOfferComplete({ name: "", price: 1000, deliveryUrl: "https://x.com" })).toThrow(/nome/);
    expect(() => assertOfferComplete({ name: "   ", price: 1000, deliveryUrl: "https://x.com" })).toThrow(/nome/);
  });

  it("rejeita preço <= 0 ou ausente", () => {
    expect(() => assertOfferComplete({ name: "Produto", price: 0, deliveryUrl: "https://x.com" })).toThrow(/preço/);
    expect(() => assertOfferComplete({ name: "Produto", price: -10, deliveryUrl: "https://x.com" })).toThrow(/preço/);
    expect(() => assertOfferComplete({ name: "Produto", price: undefined, deliveryUrl: "https://x.com" })).toThrow(/preço/);
  });

  it("rejeita quando nenhum campo de entrega está preenchido — accessDays sozinho não conta", () => {
    expect(() => assertOfferComplete({ name: "Produto", price: 1000 })).toThrow(/entrega/);
    expect(() => assertOfferComplete({ name: "Produto", price: 1000, deliveryUrl: "  " })).toThrow(/entrega/);
  });
});

describe("createOffer — validação server-side", () => {
  it("rejeita oferta sem entrega configurada e não grava nada", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    await expect(createOffer({ botId: bot.id, name: "Produto", price: 1000 })).rejects.toThrow(/entrega/);

    const db = await testDb();
    const rows = await db.select().from(funnelOffers).where(eq(funnelOffers.botId, bot.id));
    expect(rows.length).toBe(0);
  });

  it("rejeita preço zerado", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    await expect(createOffer({ botId: bot.id, name: "Produto", price: 0, deliveryUrl: "https://x.com" }))
      .rejects.toThrow(/preço/);
  });

  it("aceita e grava oferta completa", async () => {
    const bot = await createBot();
    authUserId = bot.userId;
    const created = await createOffer({ botId: bot.id, name: "Produto", price: 1000, deliveryUrl: "https://x.com" });

    const db = await testDb();
    const [row] = await db.select().from(funnelOffers).where(eq(funnelOffers.id, created.id));
    expect(row.name).toBe("Produto");
    expect(row.price).toBe(1000);
  });
});

describe("createOffersBulk — validação server-side", () => {
  it("rejeita o lote inteiro se qualquer oferta estiver incompleta, e não grava nenhuma", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    await expect(createOffersBulk({
      offers: [
        { botId: bot.id, name: "Oferta OK", price: 1000, deliveryUrl: "https://x.com" },
        { botId: bot.id, name: "", price: 1000, deliveryUrl: "https://x.com" },
      ],
    })).rejects.toThrow(/oferta 2/);

    const db = await testDb();
    const rows = await db.select().from(funnelOffers).where(eq(funnelOffers.botId, bot.id));
    expect(rows.length).toBe(0);
  });

  it("aceita e grava lote com todas as ofertas completas", async () => {
    const bot = await createBot();
    authUserId = bot.userId;

    const result = await createOffersBulk({
      offers: [
        { botId: bot.id, name: "A", price: 1000, deliveryUrl: "https://x.com" },
        { botId: bot.id, name: "B", price: 2000, deliveryText: "conteúdo aqui" },
      ],
    });

    expect(result.offers.length).toBe(2);
    const db = await testDb();
    const rows = await db.select().from(funnelOffers).where(eq(funnelOffers.botId, bot.id));
    expect(rows.length).toBe(2);
  });
});

// Funil flow: `saveFlow` é autosave genérico (roda a cada edição de nó/aresta)
// e NÃO valida mais completude de oferta — bloqueava até o autosave de um
// rascunho legítimo (backlog `bug-ao-exportar-funis-97h57c`). A checagem de
// completude foi movida para `activate` (ver describe abaixo).
describe("saveFlow — aceita qualquer oferta, completa ou não (validação movida pra activate)", () => {
  async function newFunnel(): Promise<string> {
    const bot = await createBot();
    const f = await repo.create({ userId: bot.userId, botId: bot.id, name: "F", kind: "flow" });
    authUserId = bot.userId;
    return f.id;
  }

  it("aceita nó offer totalmente vazio (rascunho legítimo)", async () => {
    const id = await newFunnel();
    await expect(saveFlow({
      id,
      nodes: [{ id: crypto.randomUUID(), type: "offer", content: { offers: [{}] }, positionX: 0, positionY: 0 }],
      connections: [],
    })).resolves.toEqual({ ok: true });
  });

  it("aceita oferta iniciada só com nome — falta preço e entrega", async () => {
    const id = await newFunnel();
    await expect(saveFlow({
      id,
      nodes: [{
        id: crypto.randomUUID(), type: "offer",
        content: { offers: [{ product_name: "Produto" }] },
        positionX: 0, positionY: 0,
      }],
      connections: [],
    })).resolves.toEqual({ ok: true });
  });

  it("aceita oferta iniciada com nome e preço, mas sem entrega configurada", async () => {
    const id = await newFunnel();
    await expect(saveFlow({
      id,
      nodes: [{
        id: crypto.randomUUID(), type: "offer",
        content: { offers: [{ product_name: "Produto", price: 1000 }] },
        positionX: 0, positionY: 0,
      }],
      connections: [],
    })).resolves.toEqual({ ok: true });
  });

  it("aceita oferta completa num nó offer dedicado", async () => {
    const id = await newFunnel();
    await expect(saveFlow({
      id,
      nodes: [{
        id: crypto.randomUUID(), type: "offer",
        content: { offers: [{ product_name: "Produto", price: 1000, delivery_url: "https://x.com" }] },
        positionX: 0, positionY: 0,
      }],
      connections: [],
    })).resolves.toEqual({ ok: true });
  });

  it("aceita oferta vip_group com só delivery_url preenchido (validação de tipo fica só pra activate)", async () => {
    const id = await newFunnel();
    await expect(saveFlow({
      id,
      nodes: [{
        id: crypto.randomUUID(), type: "offer",
        content: { offers: [{ product_name: "Produto", price: 1000, product_type: "vip_group", delivery_url: "https://exemplo.com" }] },
        positionX: 0, positionY: 0,
      }],
      connections: [],
    })).resolves.toEqual({ ok: true });
  });

  it("aceita shape legado de oferta única (product_id direto em content, sem array offers) mesmo incompleto", async () => {
    const id = await newFunnel();
    await expect(saveFlow({
      id,
      nodes: [{
        id: crypto.randomUUID(), type: "offer",
        content: { product_id: "legacy-1", product_name: "Produto legado", price: 1000 },
        positionX: 0, positionY: 0,
      }],
      connections: [],
    })).resolves.toEqual({ ok: true });
  });

  it("não afeta funil sem nenhuma oferta (nós de trigger/mensagem comuns)", async () => {
    const id = await newFunnel();
    const n1 = crypto.randomUUID(); const n2 = crypto.randomUUID();
    await expect(saveFlow({
      id,
      nodes: [
        { id: n1, type: "trigger", content: {}, positionX: 0, positionY: 0 },
        { id: n2, type: "message", content: { message: "oi" }, positionX: 0, positionY: 0 },
      ],
      connections: [{ id: crypto.randomUUID(), sourceNodeId: n1, sourceHandle: null, targetNodeId: n2 }],
    })).resolves.toEqual({ ok: true });
  });
});

// `activate` é o gate real de completude agora: rascunho pode ser salvo
// incompleto (ver describe acima), mas o funil só liga se todas as ofertas
// "iniciadas" (nome ou preço preenchidos) estiverem completas — pra ambos os
// tipos de funil (paridade flow/simplificado, ver CLAUDE.md).
describe("activate — bloqueia funil com oferta incompleta (rascunho vazio passa)", () => {
  async function newFlowFunnel(): Promise<string> {
    const bot = await createBot();
    const f = await repo.create({ userId: bot.userId, botId: bot.id, name: "F", kind: "flow" });
    authUserId = bot.userId;
    return f.id;
  }

  async function newSimplifiedFunnel(): Promise<string> {
    const bot = await createBot();
    const f = await repo.create({ userId: bot.userId, botId: bot.id, name: "F", kind: "simplified" });
    authUserId = bot.userId;
    return f.id;
  }

  it("funil flow: rejeita ativação com oferta iniciada e incompleta num nó offer", async () => {
    const id = await newFlowFunnel();
    await saveFlow({
      id,
      nodes: [{
        id: crypto.randomUUID(), type: "offer",
        content: { offers: [{ product_name: "Produto", price: 1000 }] },
        positionX: 0, positionY: 0,
      }],
      connections: [],
    });
    await expect(activate({ id })).rejects.toThrow(/não é possível ativar.*entrega/i);
  });

  it("funil flow: rejeita ativação com oferta vip_group sem telegram_group_id", async () => {
    const id = await newFlowFunnel();
    await saveFlow({
      id,
      nodes: [{
        id: crypto.randomUUID(), type: "offer",
        content: { offers: [{ product_name: "Produto", price: 1000, product_type: "vip_group", delivery_url: "https://exemplo.com" }] },
        positionX: 0, positionY: 0,
      }],
      connections: [],
    });
    await expect(activate({ id })).rejects.toThrow(/não é possível ativar.*grupo VIP/i);
  });

  it("funil flow: aceita ativação com oferta completa", async () => {
    const id = await newFlowFunnel();
    await saveFlow({
      id,
      nodes: [{
        id: crypto.randomUUID(), type: "offer",
        content: { offers: [{ product_name: "Produto", price: 1000, delivery_url: "https://x.com" }] },
        positionX: 0, positionY: 0,
      }],
      connections: [],
    });
    await expect(activate({ id })).resolves.toEqual({ ok: true });
  });

  it("funil flow: aceita ativação quando a oferta está totalmente vazia (rascunho legítimo, não 'iniciada')", async () => {
    const id = await newFlowFunnel();
    await saveFlow({
      id,
      nodes: [{ id: crypto.randomUUID(), type: "offer", content: { offers: [{}] }, positionX: 0, positionY: 0 }],
      connections: [],
    });
    await expect(activate({ id })).resolves.toEqual({ ok: true });
  });

  it("funil simplificado: rejeita ativação com plano iniciado sem entrega", async () => {
    const id = await newSimplifiedFunnel();
    await update({ id, simplifiedConfig: { plans: [{ name: "Plano Básico", price: 1000 }] } });
    await expect(activate({ id })).rejects.toThrow(/não é possível ativar.*entrega/i);
  });

  // `deliveryTypeOf` em execute-simplified-funnel.use-case.ts infere "vip_group"
  // quando `vip_group_id` está preenchido mesmo sem `delivery_type` explícito
  // (shape legado/da UI). A validação de ativação precisa da mesma inferência
  // — senão rejeitaria (pedindo "URL de entrega") um item que entrega certinho
  // em produção.
  it("funil simplificado: aceita plano com vip_group_id preenchido mesmo sem delivery_type explícito", async () => {
    const id = await newSimplifiedFunnel();
    await update({ id, simplifiedConfig: { plans: [{ name: "Plano VIP", price: 1000, vip_group_id: "-100987" }] } });
    await expect(activate({ id })).resolves.toEqual({ ok: true });
  });

  it("funil simplificado: rejeita ativação com upsell vip_group sem vip_group_id", async () => {
    const id = await newSimplifiedFunnel();
    await update({
      id,
      simplifiedConfig: { upsells: [{ name: "Upsell VIP", price: 2000, delivery_type: "vip_group" }] },
    });
    await expect(activate({ id })).rejects.toThrow(/não é possível ativar.*grupo VIP/i);
  });

  it("funil simplificado: rejeita ativação com order bump de entrega tipo texto sem delivery_text", async () => {
    const id = await newSimplifiedFunnel();
    await update({
      id,
      simplifiedConfig: { order_bumps: [{ name: "Bump", price: 500, delivery_type: "text" }] },
    });
    await expect(activate({ id })).rejects.toThrow(/não é possível ativar.*texto de entrega/i);
  });

  it("funil simplificado: aceita ativação quando plans/upsells/downsells/order_bumps estão completos", async () => {
    const id = await newSimplifiedFunnel();
    await update({
      id,
      simplifiedConfig: {
        plans: [{ name: "Plano", price: 1000, delivery_type: "content", delivery_url: "https://x.com" }],
        upsells: [{ name: "Upsell", price: 2000, delivery_type: "text", delivery_text: "acesse assim" }],
        downsells: [{ name: "Downsell", price: 500, delivery_type: "vip_group", vip_group_id: "-100123" }],
        order_bumps: [{ name: "Bump", price: 300, delivery_type: "content", delivery_url: "https://x.com/bump" }],
      },
    });
    await expect(activate({ id })).resolves.toEqual({ ok: true });
  });

  it("funil simplificado: aceita ativação quando não há nenhum item cadastrado (rascunho vazio)", async () => {
    const id = await newSimplifiedFunnel();
    await expect(activate({ id })).resolves.toEqual({ ok: true });
  });
});
