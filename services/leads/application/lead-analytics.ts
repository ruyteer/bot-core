import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../../shared/database.js";

// drizzle/node-postgres db.execute() devolve QueryResult<T> — extrai as linhas.
async function exec<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface AnalyticsTotals {
  /** Leads no escopo (bot + período). Base de TODAS as demais somas. */
  leads:          number;
  /** Leads com progresso de fluxo em status 'active'. */
  active:         number;
  /** Leads com pelo menos um PIX gerado (pago ou não). */
  pixGenerated:   number;
  /** Leads com pelo menos um pagamento aprovado. */
  purchased:      number;
  /** Leads com utm_source preenchido. */
  fromAds:        number;
  /** purchased / leads * 100 (uma casa). */
  conversionRate: number;
}

export interface StageBucket {
  key:      string;
  label:    string;
  /** Tipo do nó do funil, ou "derived" quando a etapa foi inferida. */
  type:     string;
  funnel:   string | null;
  count:    number;
  percent:  number;
  /** true = etapa inferida de sinais (funil simplificado não grava nó). */
  derived:  boolean;
}

export interface JourneyStep {
  key:            string;
  label:          string;
  /** Leads que chegaram nesta etapa (ou além dela). */
  reached:        number;
  /** Leads que pararam aqui e não chegaram na etapa seguinte. */
  dropped:        number;
  /** dropped / reached * 100 (uma casa). */
  dropRate:       number;
  /** reached / total de leads * 100 (uma casa). */
  percentOfTotal: number;
}

export interface SourceBucket {
  key:       string;
  label:     string;
  count:     number;
  percent:   number;
  purchased: number;
}

export interface TrafficTypeBucket {
  key:     string;
  label:   string;
  count:   number;
  percent: number;
}

export interface LeadAnalytics {
  totals:       AnalyticsTotals;
  stages:       StageBucket[];
  journey:      JourneyStep[];
  sources:      SourceBucket[];
  trafficTypes: TrafficTypeBucket[];
  /** Quantos leads têm etapa real (nó do funil de fluxo) vs. etapa inferida. */
  coverage:     { tracked: number; derived: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NODE_TYPE_LABELS: Record<string, string> = {
  trigger:       "Gatilho",
  message:       "Mensagem",
  media:         "Mídia",
  audio:         "Áudio",
  buttons:       "Botões",
  input:         "Pergunta",
  delay:         "Espera",
  condition:     "Condição",
  random:        "Aleatório",
  offer:         "Oferta",
  wait_response: "Aguardando resposta",
};

/** Rótulo legível de um nó — mesma heurística usada na listagem de leads. */
function summarizeNode(type: string, content: Record<string, unknown>): string {
  const fallback = NODE_TYPE_LABELS[type] ?? type;
  if (type === "trigger" && typeof content.command === "string") return `Gatilho: ${content.command}`;
  if (type === "offer") {
    const offers = (content.offers as Array<{ product_name?: string }>) ?? [];
    if (offers[0]?.product_name) return `Oferta: ${offers[0].product_name}`;
  }
  if (type === "message") {
    const blocks = (content.blocks as Array<{ type: string; content?: string }>) ?? [];
    const text = blocks.find((b) => b.type === "text" && b.content)?.content;
    if (typeof text === "string" && text.trim()) {
      const t = text.trim().replace(/\s+/g, " ");
      return t.length > 34 ? `${t.slice(0, 34)}…` : t;
    }
  }
  if (typeof content.label === "string" && content.label.trim()) return content.label.trim();
  return fallback;
}

const pct = (part: number, total: number): number =>
  total > 0 ? Math.round((part / total) * 1000) / 10 : 0;

const DERIVED_LABELS: Record<string, { label: string; order: number }> = {
  derived_start: { label: "Só iniciou o bot",          order: 1 },
  flow_no_node:  { label: "Entrou no funil (sem nó)",  order: 2 },
  derived_pix:   { label: "Gerou PIX, não pagou",      order: 3 },
  derived_paid:  { label: "Comprou",                   order: 4 },
};

const SOURCE_LABELS: Record<string, string> = {
  fb: "Facebook", facebook: "Facebook",
  ig: "Instagram", instagram: "Instagram",
  google: "Google", gg: "Google", adwords: "Google",
  tt: "TikTok", tiktok: "TikTok",
  yt: "YouTube", youtube: "YouTube",
  kwai: "Kwai",
  x: "X / Twitter", twitter: "X / Twitter",
  telegram: "Telegram", tg: "Telegram",
  whatsapp: "WhatsApp",
};

const NO_SOURCE_KEY = "__none__";

// ─── Query ───────────────────────────────────────────────────────────────────

/**
 * Agregações de comportamento dos leads. Tudo é contado em SQL a partir de um
 * único escopo (`scope`: bot + janela de created_at), então todas as visões
 * fecham com `totals.leads`:
 *  - soma de `stages`       === totals.leads
 *  - soma de `sources`      === totals.leads
 *  - soma de `trafficTypes` === totals.leads
 *  - `journey` é cumulativo e monotônico (cada lead entra na etapa MAIS
 *    avançada que alcançou; reached[k] = quantos alcançaram ≥ k).
 *
 * Limitação real (não mascarada): o funil SIMPLIFICADO não grava nó/etapa em
 * lead_progress. Para esses leads a etapa é inferida de sinais existentes
 * (PIX gerado / pagamento aprovado) e vem marcada com `derived: true`.
 */
export async function getLeadAnalytics(
  botIds: string[],
  startDate?: Date,
  endDate?: Date,
): Promise<LeadAnalytics> {
  const empty: LeadAnalytics = {
    totals:       { leads: 0, active: 0, pixGenerated: 0, purchased: 0, fromAds: 0, conversionRate: 0 },
    stages:       [],
    journey:      [],
    sources:      [],
    trafficTypes: [],
    coverage:     { tracked: 0, derived: 0 },
  };
  if (botIds.length === 0) return empty;

  // `sql` do drizzle expande um array JS em vários placeholders — para uma lista
  // é preciso montar o IN explicitamente (nada de sql.raw com valor do usuário).
  const idList = (ids: string[]): SQL => sql.join(ids.map((v) => sql`${v}::uuid`), sql`, `);

  const botFilter = sql`l.bot_id IN (${idList(botIds)})`;
  const dateFilter = sql`${startDate ? sql`AND l.created_at >= ${startDate.toISOString()}::timestamptz` : sql``}
                         ${endDate   ? sql`AND l.created_at <= ${endDate.toISOString()}::timestamptz`   : sql``}`;

  // CTEs compartilhadas: o MESMO escopo em toda consulta garante que as somas fechem.
  const scope = sql`
    scope AS (
      SELECT l.id, l.utm_source
      FROM leads l
      WHERE ${botFilter} ${dateFilter}
    ),
    pay AS (
      SELECT p.lead_id,
             count(*)::int                                                      AS n,
             count(*) FILTER (WHERE p.status IN ('paid','approved'))::int        AS n_paid
      FROM payments p
      WHERE p.lead_id IN (SELECT id FROM scope)
      GROUP BY p.lead_id
    ),
    prog AS (
      SELECT DISTINCT ON (lp.lead_id)
             lp.lead_id, lp.funnel_id, lp.current_node_id, lp.status
      FROM lead_progress lp
      WHERE lp.lead_id IN (SELECT id FROM scope)
      ORDER BY lp.lead_id, (lp.current_node_id IS NOT NULL) DESC, lp.updated_at DESC
    )
  `;

  // ── 1) Totais + escada de progressão (etapa mais avançada alcançada) ──────
  const [t] = await exec<{
    total: number; engaged: number; pix: number; paid: number;
    active: number; from_ads: number; tracked: number;
  }>(sql`
    WITH ${scope},
    classified AS (
      SELECT
        pr.lead_id IS NOT NULL AND pr.current_node_id IS NOT NULL AS tracked,
        pr.status                                                 AS prog_status,
        s.utm_source,
        GREATEST(
          1,
          CASE WHEN pr.current_node_id IS NOT NULL AND n.type::text <> 'trigger' THEN 2 ELSE 1 END,
          CASE WHEN COALESCE(pa.n, 0)      > 0 THEN 3 ELSE 1 END,
          CASE WHEN COALESCE(pa.n_paid, 0) > 0 THEN 4 ELSE 1 END
        ) AS stage
      FROM scope s
      LEFT JOIN prog pr        ON pr.lead_id = s.id
      LEFT JOIN funnel_nodes n ON n.id       = pr.current_node_id
      LEFT JOIN pay pa         ON pa.lead_id = s.id
    )
    SELECT
      count(*)::int                                                                  AS total,
      count(*) FILTER (WHERE stage >= 2)::int                                        AS engaged,
      count(*) FILTER (WHERE stage >= 3)::int                                        AS pix,
      count(*) FILTER (WHERE stage >= 4)::int                                        AS paid,
      count(*) FILTER (WHERE prog_status = 'active')::int                            AS active,
      count(*) FILTER (WHERE utm_source IS NOT NULL AND btrim(utm_source) <> '')::int AS from_ads,
      count(*) FILTER (WHERE tracked)::int                                           AS tracked
    FROM classified
  `);

  const total = Number(t?.total ?? 0);
  if (total === 0) return empty;

  const reachedRaw = [total, Number(t.engaged ?? 0), Number(t.pix ?? 0), Number(t.paid ?? 0)];
  const journeyLabels = [
    { key: "start",     label: "Iniciou o bot" },
    { key: "engaged",   label: "Avançou no funil" },
    { key: "pix",       label: "Gerou PIX" },
    { key: "purchased", label: "Pagou" },
  ];
  const journey: JourneyStep[] = journeyLabels.map((s, i) => {
    const reached = reachedRaw[i];
    const next    = i + 1 < reachedRaw.length ? reachedRaw[i + 1] : 0;
    const dropped = Math.max(0, reached - next);
    return {
      key:            s.key,
      label:          s.label,
      reached,
      dropped:        i + 1 < reachedRaw.length ? dropped : 0,
      dropRate:       i + 1 < reachedRaw.length ? pct(dropped, reached) : 0,
      percentOfTotal: pct(reached, total),
    };
  });

  // ── 2) Onde cada lead parou (um bucket por lead) ──────────────────────────
  const bucketRows = await exec<{ bucket: string; n: number }>(sql`
    WITH ${scope}
    SELECT
      CASE
        WHEN pr.current_node_id IS NOT NULL      THEN 'node:' || pr.current_node_id::text
        WHEN pr.lead_id IS NOT NULL              THEN 'flow_no_node'
        WHEN COALESCE(pa.n_paid, 0) > 0          THEN 'derived_paid'
        WHEN COALESCE(pa.n, 0)      > 0          THEN 'derived_pix'
        ELSE 'derived_start'
      END        AS bucket,
      count(*)::int AS n
    FROM scope s
    LEFT JOIN prog pr ON pr.lead_id = s.id
    LEFT JOIN pay  pa ON pa.lead_id = s.id
    GROUP BY 1
  `);

  const nodeIds = bucketRows
    .filter((r) => r.bucket.startsWith("node:"))
    .map((r) => r.bucket.slice(5));

  // Metadados + profundidade topológica dos nós (BFS a partir do gatilho, com
  // proteção de ciclo). A ordem do gráfico segue a ordem real do funil.
  type NodeMeta = { id: string; type: string; content: Record<string, unknown>; funnel_name: string | null; depth: number };
  const nodeMeta = new Map<string, NodeMeta>();
  if (nodeIds.length > 0) {
    const rows = await exec<NodeMeta>(sql`
      WITH RECURSIVE targets AS (
        SELECT DISTINCT funnel_id FROM funnel_nodes WHERE id IN (${idList(nodeIds)})
      ),
      walk AS (
        SELECT n.id, n.funnel_id, 0 AS depth, ARRAY[n.id] AS path
        FROM funnel_nodes n
        JOIN targets t ON t.funnel_id = n.funnel_id
        WHERE n.type::text = 'trigger'
        UNION ALL
        SELECT c.target_node_id, w.funnel_id, w.depth + 1, w.path || c.target_node_id
        FROM walk w
        JOIN node_connections c
          ON c.source_node_id = w.id AND c.funnel_id = w.funnel_id
        WHERE NOT (c.target_node_id = ANY(w.path)) AND w.depth < 60
      ),
      depths AS (SELECT id, min(depth) AS depth FROM walk GROUP BY id)
      SELECT n.id,
             n.type::text                AS type,
             n.content                   AS content,
             f.name                      AS funnel_name,
             COALESCE(d.depth, 9999)::int AS depth
      FROM funnel_nodes n
      LEFT JOIN funnels f ON f.id = n.funnel_id
      LEFT JOIN depths  d ON d.id = n.id
      WHERE n.id IN (${idList(nodeIds)})
    `);
    for (const r of rows) nodeMeta.set(r.id, r);
  }

  const stages: Array<StageBucket & { _order: number }> = bucketRows.map((r) => {
    const count = Number(r.n);
    if (r.bucket.startsWith("node:")) {
      const id = r.bucket.slice(5);
      const m = nodeMeta.get(id);
      return {
        key:     r.bucket,
        label:   m ? summarizeNode(m.type, (m.content as Record<string, unknown>) ?? {}) : "Etapa removida",
        type:    m?.type ?? "unknown",
        funnel:  m?.funnel_name ?? null,
        count,
        percent: pct(count, total),
        derived: false,
        _order:  m ? Number(m.depth) : 9999,
      };
    }
    const d = DERIVED_LABELS[r.bucket] ?? { label: r.bucket, order: 9999 };
    return {
      key:     r.bucket,
      label:   d.label,
      type:    "derived",
      funnel:  null,
      count,
      percent: pct(count, total),
      derived: true,
      _order:  10_000 + d.order,
    };
  });
  stages.sort((a, b) => a._order - b._order || b.count - a.count);

  // ── 3) Fonte de tráfego (utm_source) — bucket "sem origem" fecha a soma ───
  const sourceRows = await exec<{ key: string; n: number; purchased: number }>(sql`
    WITH ${scope}
    SELECT
      COALESCE(NULLIF(lower(btrim(s.utm_source)), ''), ${NO_SOURCE_KEY})   AS key,
      count(*)::int                                                        AS n,
      count(*) FILTER (WHERE COALESCE(pa.n_paid, 0) > 0)::int              AS purchased
    FROM scope s
    LEFT JOIN pay pa ON pa.lead_id = s.id
    GROUP BY 1
    ORDER BY 2 DESC
  `);

  const sources: SourceBucket[] = sourceRows.map((r) => ({
    key:       r.key,
    label:     r.key === NO_SOURCE_KEY
      ? "Sem origem (orgânico/direto)"
      : (SOURCE_LABELS[r.key] ?? r.key),
    count:     Number(r.n),
    percent:   pct(Number(r.n), total),
    purchased: Number(r.purchased),
  }));

  // ── 4) Tipo de tráfego: pago (link rastreável) vs orgânico marcado vs direto ─
  const trafficRows = await exec<{ key: string; n: number }>(sql`
    WITH ${scope},
    clicked AS (
      SELECT DISTINCT tc.lead_id FROM tracking_clicks tc
      WHERE tc.lead_id IN (SELECT id FROM scope)
    )
    SELECT
      CASE
        WHEN c.lead_id IS NOT NULL                                       THEN 'paid'
        WHEN s.utm_source IS NOT NULL AND btrim(s.utm_source) <> ''      THEN 'organic_tagged'
        ELSE 'direct'
      END        AS key,
      count(*)::int AS n
    FROM scope s
    LEFT JOIN clicked c ON c.lead_id = s.id
    GROUP BY 1
  `);

  const TRAFFIC_LABELS: Record<string, string> = {
    paid:           "Tráfego pago (link rastreável)",
    organic_tagged: "Orgânico com UTM",
    direct:         "Direto / sem rastreio",
  };
  const TRAFFIC_ORDER = ["paid", "organic_tagged", "direct"];
  const trafficTypes: TrafficTypeBucket[] = trafficRows
    .map((r) => ({
      key:     r.key,
      label:   TRAFFIC_LABELS[r.key] ?? r.key,
      count:   Number(r.n),
      percent: pct(Number(r.n), total),
    }))
    .sort((a, b) => TRAFFIC_ORDER.indexOf(a.key) - TRAFFIC_ORDER.indexOf(b.key));

  const tracked = Number(t.tracked ?? 0);

  return {
    totals: {
      leads:          total,
      active:         Number(t.active ?? 0),
      pixGenerated:   Number(t.pix ?? 0),
      purchased:      Number(t.paid ?? 0),
      fromAds:        Number(t.from_ads ?? 0),
      conversionRate: pct(Number(t.paid ?? 0), total),
    },
    stages:   stages.map(({ _order, ...s }) => s),
    journey,
    sources,
    trafficTypes,
    coverage: { tracked, derived: total - tracked },
  };
}
