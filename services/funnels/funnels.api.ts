import { api, APIError } from "encore.dev/api";
import { scanSourceAsync } from "../compliance/application/scan.js";
import { getAuthData } from "~encore/auth";
import { FunnelDrizzleRepository } from "./infrastructure/funnel.drizzle.repository.js";
import {
  assertOfferComplete, assertRawOfferComplete, assertSimplifiedOfferComplete,
  type RawNodeOffer, type RawSimplifiedOfferItem,
} from "./domain/offer-validation.js";
import { collectNodeOffers } from "../runner/application/execute-flow-step.use-case.js";
import type { FunnelWithBots, FunnelDetail, SaveFlowInput } from "./domain/funnel.entity.js";
import { db } from "../shared/database.js";
import { funnelOffers, leadProgress, payments, funnelNodes, bots } from "../shared/schema/index.js";
import type { SQL } from "drizzle-orm";
import { eq, and, inArray, sql } from "drizzle-orm";

const repo = new FunnelDrizzleRepository();

// ─── Response shapes ─────────────────────────────────────────────────────────

interface FunnelResponse {
  id:        string;
  name:      string;
  kind:      string;
  isActive:  boolean;
  botId:     string | null;
  bots:      { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

interface FunnelDetailResponse extends FunnelResponse {
  nodes: Array<{
    id:        string;
    type:      string;
    content:   Record<string, unknown>;
    positionX: number;
    positionY: number;
  }>;
  connections: Array<{
    id:           string;
    sourceNodeId: string;
    sourceHandle: string | null;
    targetNodeId: string;
  }>;
  simplifiedConfig: Record<string, unknown>;
}

function toResponse(f: FunnelWithBots): FunnelResponse {
  return {
    id:        f.id,
    name:      f.name,
    kind:      f.kind,
    isActive:  f.isActive,
    botId:     f.botId,
    bots:      f.bots,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function toDetailResponse(f: FunnelDetail): FunnelDetailResponse {
  return {
    ...toResponse(f),
    simplifiedConfig: f.simplifiedConfig,
    nodes:       f.nodes.map((n) => ({
      id: n.id, type: n.type, content: n.content,
      positionX: n.positionX, positionY: n.positionY,
    })),
    connections: f.connections.map((c) => ({
      id: c.id, sourceNodeId: c.sourceNodeId,
      sourceHandle: c.sourceHandle, targetNodeId: c.targetNodeId,
    })),
  };
}

// Um funil só pode ficar ATIVO (recebendo clientes de verdade) com todas as
// ofertas "iniciadas" (nome ou preço preenchidos) completas — nome, preço e
// entrega configurada. Rascunho (salvar/editar) NÃO passa mais por essa
// checagem (ver `saveFlow`/`update` abaixo); só `activate`, pra não bloquear
// edição mas ainda impedir "paga e não entrega, silenciosamente" em produção
// (achado de revisão de segurança — ver `offer-validation.ts`).
function assertFunnelReadyToActivate(detail: FunnelDetail): void {
  if (detail.kind === "simplified") {
    const cfg = (detail.simplifiedConfig ?? {}) as Record<string, unknown>;
    const sections: Array<{ key: string; article: string }> = [
      { key: "plans",       article: "o plano" },
      { key: "upsells",     article: "o upsell" },
      { key: "downsells",   article: "o downsell" },
      { key: "order_bumps", article: "o order bump" },
    ];
    for (const { key, article } of sections) {
      const items = cfg[key];
      if (!Array.isArray(items)) continue;
      items.forEach((item, i) => {
        const raw = (item ?? {}) as RawSimplifiedOfferItem;
        const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `#${i + 1}`;
        assertSimplifiedOfferComplete(raw, `não é possível ativar: ${article} "${name}"`);
      });
    }
    return;
  }

  for (const node of detail.nodes) {
    const content = (node.content ?? {}) as Record<string, unknown>;
    // Mesmo fallback de rótulo usado em `nodeStats` (linha ~433) — o id do nó é
    // um uuid interno, não ajuda o usuário a achar o nó na UI do editor.
    const nodeLabel = (content.label as string | undefined) ?? node.type;
    const offers = collectNodeOffers(content);
    for (const { offer, handleId } of offers) {
      assertRawOfferComplete(offer as RawNodeOffer, `não é possível ativar: a oferta "${handleId}" no nó "${nodeLabel}"`);
    }
    // Shape legado de oferta única — ver mesmo comentário em `saveFlow` (git
    // blame / histórico): collectNodeOffers só lê `content.offers`/`content.blocks`.
    if (!Array.isArray(content.offers) && typeof content.product_id === "string") {
      assertRawOfferComplete(content as RawNodeOffer, `não é possível ativar: a oferta no nó "${nodeLabel}"`);
    }
  }
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// GET /funnels?botId=...
export const list = api(
  { method: "GET", path: "/funnels", expose: true, auth: true },
  async ({ botId }: { botId?: string }): Promise<{ funnels: FunnelResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    const result = await repo.findByUserId(userId, botId);
    return { funnels: result.map(toResponse) };
  },
);

// GET /funnels/:id
export const get = api(
  { method: "GET", path: "/funnels/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<FunnelDetailResponse> => {
    const { userID: userId } = getAuthData()!;
    const result = await repo.findByIdOwned(id, userId);
    if (!result) throw APIError.notFound("funnel not found");
    return toDetailResponse(result);
  },
);

// POST /funnels
export const create = api(
  { method: "POST", path: "/funnels", expose: true, auth: true },
  async (req: { name: string; botId: string; kind?: string }): Promise<FunnelResponse> => {
    const { userID: userId } = getAuthData()!;
    const botRow = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, req.botId), eq(bots.userId, userId))).limit(1);
    if (!botRow.length) throw APIError.notFound("bot not found");
    const funnel = await repo.create({
      userId,
      botId: req.botId,
      name:  req.name,
      kind:  req.kind ?? "flow",
    });
    scanSourceAsync("funnel", funnel.id);
    return toResponse({ ...funnel, bots: [{ id: req.botId, name: "" }] });
  },
);

// PATCH /funnels/:id
export const update = api(
  { method: "PATCH", path: "/funnels/:id", expose: true, auth: true },
  async ({ id, ...req }: { id: string; name?: string; botId?: string | null; simplifiedConfig?: Record<string, unknown> }): Promise<FunnelResponse> => {
    const { userID: userId } = getAuthData()!;
    const funnel = await repo.update(id, userId, req);
    const detail = await repo.findByIdOwned(funnel.id, userId);
    if (!detail) throw APIError.notFound("funnel not found");
    scanSourceAsync("funnel", funnel.id);
    return toResponse(detail);
  },
);

// DELETE /funnels/:id
export const remove = api(
  { method: "DELETE", path: "/funnels/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<void> => {
    const { userID: userId } = getAuthData()!;
    await repo.delete(id, userId);
  },
);

// POST /funnels/:id/activate
export const activate = api(
  { method: "POST", path: "/funnels/:id/activate", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const detail = await repo.findByIdOwned(id, userId);
    if (!detail) throw APIError.notFound("funnel not found");
    // Sem transação/lock entre a leitura acima e o UPDATE em repo.activate: um
    // saveFlow/update concorrente que torne uma oferta incompleta nessa janela
    // passaria despercebido. Aceitável por ora (exige corrida real editando e
    // ativando ao mesmo tempo); revisitar se isso virar um problema de verdade.
    assertFunnelReadyToActivate(detail);
    await repo.activate(id, userId);
    return { ok: true };
  },
);

// DELETE /funnels/:id/activate
export const deactivate = api(
  { method: "DELETE", path: "/funnels/:id/activate", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await repo.deactivate(id, userId);
    return { ok: true };
  },
);

// PUT /funnels/:id/flow — save nodes + connections (full replace)
//
// Autosave genérico: dispara a cada edição (mover nó, conectar aresta, editar
// texto), não só quando uma oferta é "finalizada" — por isso NÃO valida mais
// completude de oferta aqui (bloqueava até o autosave de um rascunho legítimo
// — ver backlog `bug-ao-exportar-funis-97h57c`). A checagem foi movida para
// `activate`: um funil só pode ficar ATIVO com todas as ofertas "iniciadas"
// completas — ver `assertFunnelReadyToActivate` acima.
export const saveFlow = api(
  { method: "PUT", path: "/funnels/:id/flow", expose: true, auth: true },
  async ({ id, nodes, connections }: { id: string } & SaveFlowInput): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await repo.saveFlow(id, userId, { nodes, connections });
    scanSourceAsync("funnel", id);
    return { ok: true };
  },
);

// POST /funnels/:id/duplicate
export const duplicate = api(
  { method: "POST", path: "/funnels/:id/duplicate", expose: true, auth: true },
  async ({ id, targetBotId }: { id: string; targetBotId: string }): Promise<FunnelResponse> => {
    const { userID: userId } = getAuthData()!;
    const funnel = await repo.duplicate(id, userId, targetBotId);
    const detail = await repo.findByIdOwned(funnel.id, userId);
    if (!detail) throw APIError.notFound("funnel not found");
    scanSourceAsync("funnel", funnel.id);
    return toResponse(detail);
  },
);

// ─── Stats ───────────────────────────────────────────────────────────────────

interface FunnelNodeStat {
  nodeId:   string;
  nodeType: string;
  label:    string;
  count:    number;
}

interface FunnelStatsResponse {
  funnelName: string;
  funnelKind: string;

  /**
   * Leads ATUALMENTE atribuídos a este funil. NÃO é histórico: `lead_progress`
   * guarda uma linha por lead e o runner faz UPDATE do `funnel_id` quando o lead
   * entra em outro funil. O rótulo correto na UI é "Leads no funil".
   */
  leadsInFunnel:   number;
  /** @deprecated alias de `leadsInFunnel`, mantido para não quebrar clients antigos. */
  totalLeads:      number;
  activeLeads:     number;
  completedLeads:  number;
  /** leadsInFunnel − activeLeads − completedLeads (nunca negativo). */
  abandonedLeads:  number;
  /** Leads distintos com ao menos 1 pagamento aprovado neste funil. */
  payingLeads:     number;

  /** Receita aprovada em CENTAVOS (mesma unidade de `payments.amount` / "Minhas Vendas"). */
  revenue: number;
  /** Nº de pagamentos aprovados (não de leads). */
  sales:   number;

  /** Média (1ª compra − criação do lead) em MILISSEGUNDOS. null se ninguém comprou. */
  avgTimeToPurchaseMs: number | null;

  nodeStats: FunnelNodeStat[];

  // ── Metadados de honestidade das métricas (para a UI rotular certo) ──
  /** Origem da contagem de leads: "lead_progress" | "payments+simplified_scheduled_tasks". */
  leadsSource:             string;
  /** true = a contagem de leads é um subconjunto (não cobre todos que entraram). */
  leadsArePartial:         boolean;
  /** false = não há estado de "em andamento" persistido; `activeLeads` vem 0. */
  activeLeadsTracked:      boolean;
  /** true = a base do tempo é `leads.created_at` (1º contato com o bot), não a entrada no funil. */
  avgTimeToPurchaseApprox: boolean;
  /** Avisos legíveis (pt-BR) sobre limitações dos números acima. */
  notes:                   string[];
}

// drizzle/node-postgres db.execute() devolve QueryResult<T> — extrai as linhas.
async function execRows<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

/**
 * Receita/vendas do funil.
 *
 * Fonte = `payments.funnel_id` (preenchido pelos DOIS motores: `execute-flow-step`
 * e `execute-simplified-funnel`). A fonte antiga (`funnel_offers.funnel_id` →
 * `payments.offer_id`) dava sempre zero: `funnel_offers.funnel_id` nunca é
 * gravado e o nó de oferta do fluxo cria o pagamento sem `offer_id`.
 *
 * Usa `payments.amount` (centavos) com `status='paid'` — exatamente o mesmo
 * critério de "Minhas Vendas", então os totais fecham entre as duas telas.
 */
async function funnelMoney(funnelId: string): Promise<{ revenue: number; sales: number; payingLeads: number }> {
  const [row] = await db
    .select({
      // sum/count voltam como numeric/bigint → string no driver pg. Number() no fim
      // evita estourar int32 em contas grandes.
      revenue: sql<string>`coalesce(sum(${payments.amount}), 0)`,
      sales:   sql<string>`count(*)`,
      payers:  sql<string>`count(distinct ${payments.leadId})`,
    })
    .from(payments)
    .where(and(eq(payments.funnelId, funnelId), eq(payments.status, "paid")));

  return {
    revenue:     Number(row?.revenue ?? 0),
    sales:       Number(row?.sales ?? 0),
    payingLeads: Number(row?.payers ?? 0),
  };
}

/**
 * Tempo médio até a compra, em ms: média de (1º pagamento aprovado − criação do lead).
 *
 * Aproximação conhecida: `leads.created_at` é o 1º contato do lead com o BOT
 * (a linha é upsertada por bot+chat), não a entrada neste funil — não existe
 * hoje nenhuma coluna que registre "entrou no funil X às HH:MM".
 */
async function avgTimeToPurchaseMs(funnelId: string): Promise<number | null> {
  const rows = await execRows<{ ms: string | null }>(sql`
    SELECT avg(t.ms)::text AS ms
    FROM (
      SELECT extract(epoch FROM (min(p.paid_at) - l.created_at)) * 1000 AS ms
      FROM payments p
      JOIN leads l ON l.id = p.lead_id
      WHERE p.funnel_id = ${funnelId}
        AND p.status = 'paid'
        AND p.paid_at IS NOT NULL
      GROUP BY p.lead_id, l.created_at
    ) t
  `);
  const raw = rows[0]?.ms;
  if (raw == null) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

/**
 * Leads de um funil SIMPLIFICADO.
 *
 * O motor simplificado NUNCA escreve em `lead_progress` (ele retorna antes do
 * insert em `execute-flow-step`), e `lead_events` não tem `funnel_id`. As duas
 * únicas tabelas que ligam lead ↔ funil simplificado são `payments.funnel_id` e
 * `simplified_scheduled_tasks.funnel_id`. Logo a contagem é PARCIAL: só aparece
 * quem chegou a gerar PIX (ou a receber upsell/downsell agendado).
 */
async function simplifiedLeadCount(funnelId: string): Promise<number> {
  const rows = await execRows<{ c: string }>(sql`
    SELECT count(*)::text AS c FROM (
      SELECT lead_id FROM payments
        WHERE funnel_id = ${funnelId} AND lead_id IS NOT NULL
      UNION
      SELECT lead_id FROM simplified_scheduled_tasks
        WHERE funnel_id = ${funnelId}
    ) t
  `);
  return Number(rows[0]?.c ?? 0);
}

// GET /funnels/:id/stats
export const stats = api(
  { method: "GET", path: "/funnels/:id/stats", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<FunnelStatsResponse> => {
    const { userID: userId } = getAuthData()!;
    const funnel = await repo.findByIdOwned(id, userId);
    if (!funnel) throw APIError.notFound("funnel not found");

    const [money, avgMs] = await Promise.all([funnelMoney(id), avgTimeToPurchaseMs(id)]);

    // ── Ramo SIMPLIFICADO: não existe `lead_progress`, tudo vem de payments ──
    if (funnel.kind === "simplified") {
      const leadsInFunnel = await simplifiedLeadCount(id);
      // "Concluiu" = comprou. Não há estado intermediário persistido, então
      // `activeLeads` é 0 por construção (e sinalizado por activeLeadsTracked).
      const completedLeads = money.payingLeads;

      return {
        funnelName: funnel.name,
        funnelKind: funnel.kind,
        leadsInFunnel,
        totalLeads:     leadsInFunnel,
        activeLeads:    0,
        completedLeads,
        abandonedLeads: Math.max(0, leadsInFunnel - completedLeads),
        payingLeads:    money.payingLeads,
        revenue:        money.revenue,
        sales:          money.sales,
        avgTimeToPurchaseMs: avgMs,
        nodeStats:      [],
        leadsSource:             "payments+simplified_scheduled_tasks",
        leadsArePartial:         true,
        activeLeadsTracked:      false,
        avgTimeToPurchaseApprox: true,
        notes: [
          "Funil simplificado não registra entrada de lead: a contagem cobre apenas leads que geraram PIX ou receberam upsell/downsell agendado.",
          "Não há estado 'em andamento' persistido; 'Ativos' vem 0 e o abandono é 'gerou PIX e não pagou'.",
          "Tempo médio até compra usa o 1º contato do lead com o bot como marco inicial.",
        ],
      };
    }

    // ── Ramo FLUXO: leads vêm de `lead_progress` ─────────────────────────────
    const progressRows = await db
      .select({ leadId: leadProgress.leadId, currentNodeId: leadProgress.currentNodeId, status: leadProgress.status })
      .from(leadProgress)
      .where(eq(leadProgress.funnelId, id));

    const leadsInFunnel  = progressRows.length;
    const activeLeads    = progressRows.filter((r) => r.status === "active").length;
    const completedLeads = progressRows.filter((r) => r.status === "completed").length;

    const nodeCounts = new Map<string, number>();
    progressRows.forEach((r) => {
      if (r.currentNodeId) nodeCounts.set(r.currentNodeId, (nodeCounts.get(r.currentNodeId) ?? 0) + 1);
    });

    let nodeStats: FunnelNodeStat[] = [];
    if (nodeCounts.size > 0) {
      const nodeRows = await db.select({ id: funnelNodes.id, type: funnelNodes.type, content: funnelNodes.content })
        .from(funnelNodes).where(inArray(funnelNodes.id, [...nodeCounts.keys()]));
      nodeStats = nodeRows.map((n) => {
        const content = n.content as Record<string, unknown>;
        const label = (content?.label as string | undefined) ?? n.type;
        return { nodeId: n.id, nodeType: n.type, label, count: nodeCounts.get(n.id) ?? 0 };
      }).sort((a, b) => b.count - a.count);
    }

    return {
      funnelName: funnel.name,
      funnelKind: funnel.kind,
      leadsInFunnel,
      totalLeads: leadsInFunnel,
      activeLeads,
      completedLeads,
      abandonedLeads: Math.max(0, leadsInFunnel - activeLeads - completedLeads),
      payingLeads:    money.payingLeads,
      revenue:        money.revenue,
      sales:          money.sales,
      avgTimeToPurchaseMs: avgMs,
      nodeStats,
      leadsSource:             "lead_progress",
      leadsArePartial:         true,
      activeLeadsTracked:      true,
      avgTimeToPurchaseApprox: true,
      notes: [
        "'Leads no funil' são os leads cujo progresso aponta para este funil AGORA — o runner sobrescreve funnel_id quando o lead migra, então não é histórico.",
        "Tempo médio até compra usa o 1º contato do lead com o bot como marco inicial.",
      ],
    };
  },
);

// GET /funnels/offers?botId=... — list funnel offers for a bot (used by broadcasts/remarketing)
export const listOffers = api(
  { method: "GET", path: "/funnels/offers", expose: true, auth: true },
  async ({ botId }: { botId?: string }): Promise<{ offers: Array<{ id: string; name: string; price: number; externalRef: string | null; botId: string; scope: string }> }> => {
    const { userID: userId } = getAuthData()!;
    const userBots = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
    const allowedBotIds = new Set(userBots.map((b) => b.id));

    if (botId && !allowedBotIds.has(botId)) throw APIError.notFound("bot not found");

    const targetBotIds = botId ? [botId] : [...allowedBotIds];
    if (targetBotIds.length === 0) return { offers: [] };

    const rows = await db.select().from(funnelOffers)
      .where(and(inArray(funnelOffers.botId, targetBotIds), eq(funnelOffers.isActive, true)));

    return {
      offers: rows.map((o) => ({
        id:          o.id,
        name:        o.name,
        price:       o.price,
        externalRef: o.externalRef,
        botId:       o.botId,
        scope:       o.scope,
      })),
    };
  },
);

// POST /funnels/offers — create a single funnel offer
export const createOffer = api(
  { method: "POST", path: "/funnels/offers", expose: true, auth: true },
  async (req: {
    botId:            string;
    name:             string;
    price:            number;
    productType?:     string;
    deliveryUrl?:     string | null;
    deliveryText?:    string | null;
    telegramGroupId?: string | null;
    accessDays?:      number;
    externalRef?:     string | null;
    scope?:           string;
    isActive?:        boolean;
  }): Promise<{ id: string; name: string; price: number; botId: string; externalRef: string | null }> => {
    const { userID: userId } = getAuthData()!;
    const bot = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, req.botId), eq(bots.userId, userId))).limit(1);
    if (!bot.length) throw APIError.notFound("bot not found");

    assertOfferComplete(req);

    const [row] = await db.insert(funnelOffers).values({
      botId:           req.botId,
      name:            req.name.trim(),
      price:           req.price,
      productType:     req.productType ?? "digital",
      deliveryUrl:     req.deliveryUrl ?? null,
      deliveryText:    req.deliveryText ?? null,
      telegramGroupId: req.telegramGroupId ?? null,
      accessDays:      req.accessDays ?? 0,
      externalRef:     req.externalRef ?? null,
      scope:           req.scope ?? "global",
      isActive:        req.isActive ?? true,
    }).returning();

    scanSourceAsync("offer", row.id);
    return { id: row.id, name: row.name, price: row.price, botId: row.botId, externalRef: row.externalRef };
  },
);

// POST /funnels/offers/bulk — create multiple funnel offers (for cross-bot replication)
export const createOffersBulk = api(
  { method: "POST", path: "/funnels/offers/bulk", expose: true, auth: true },
  async ({ offers }: { offers: Array<{ botId: string; name: string; price: number; productType?: string; deliveryUrl?: string | null; deliveryText?: string | null; telegramGroupId?: string | null; accessDays?: number; externalRef?: string | null; scope?: string; isActive?: boolean }> }): Promise<{ offers: Array<{ id: string; name: string; price: number; botId: string }> }> => {
    const { userID: userId } = getAuthData()!;
    if (offers.length === 0) return { offers: [] };

    const userBots = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
    const allowedIds = new Set(userBots.map((b) => b.id));
    if (!offers.every((o) => allowedIds.has(o.botId))) throw APIError.permissionDenied("bot not owned");

    offers.forEach((o, i) => assertOfferComplete(o, `a oferta ${i + 1}`));

    const rows = await db.insert(funnelOffers).values(
      offers.map((o) => ({
        botId:           o.botId,
        name:            o.name.trim(),
        price:           o.price,
        productType:     o.productType ?? "digital",
        deliveryUrl:     o.deliveryUrl ?? null,
        deliveryText:    o.deliveryText ?? null,
        telegramGroupId: o.telegramGroupId ?? null,
        accessDays:      o.accessDays ?? 0,
        externalRef:     o.externalRef ?? null,
        scope:           o.scope ?? "global",
        isActive:        o.isActive ?? true,
      }))
    ).returning();

    for (const r of rows) scanSourceAsync("offer", r.id);
    return { offers: rows.map((r) => ({ id: r.id, name: r.name, price: r.price, botId: r.botId })) };
  },
);

// PUT /funnels/:id/bots — replace bot assignments
export const assignBots = api(
  { method: "PUT", path: "/funnels/:id/bots", expose: true, auth: true },
  async ({ id, botIds }: { id: string; botIds: string[] }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await repo.assignBots(id, userId, botIds);
    return { ok: true };
  },
);
