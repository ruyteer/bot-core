import { eq, and, ne, or, desc, sql, isNull, inArray } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  leads, leadProgress, leadVariables, leadMessages,
  funnels, funnelBots, funnelNodes, nodeConnections, scheduledDelays, bots, botGroups,
  funnelOffers, leadEvents,
} from "../../shared/schema/index.js";
import { TelegramClient, urlButtonMarkup, pixCopyButtonMarkup } from "./telegram.client.js";
import { decrypt } from "../../shared/crypto.js";
import { interpolate, mergeLeadFields } from "./interpolate.js";
import type { TelegramUpdate, TelegramChatMemberUpdated } from "../../shared/events/index.js";
// Geração de PIX / persistência de cobrança vivem em `payments`, mas são código
// puro (fetch + repositórios sobre o `db` compartilhado), sem recursos Encore —
// importáveis aqui sem cruzar a fronteira de serviço.
import { GatewayDrizzleRepository } from "../../payments/infrastructure/gateway.drizzle.repository.js";
import { PaymentDrizzleRepository, type SaleType } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { createPixWithFallback } from "../../payments/application/create-pix-with-fallback.js";
import { encoreExternalUrl } from "../../config/secrets.js";
import type { Payment } from "../../payments/domain/payment.entity.js";
import { ExecuteSimplifiedFunnelUseCase } from "./execute-simplified-funnel.use-case.js";
import { applyStartTracking } from "../../leads/application/tracking-click.js";
import { enqueuePixelEvents } from "../../bots/application/pixel-events.js";

const gwRepo  = new GatewayDrizzleRepository();
const payRepo = new PaymentDrizzleRepository();
const simplifiedUseCase = new ExecuteSimplifiedFunnelUseCase();

/**
 * "Este funil pertence a este bot?" — pelas DUAS vias que o produto oferece.
 *
 * `funnels.bot_id` é o bot primário, gravado na criação. Mas a UI permite
 * vincular até 5 bots a um funil, e esse vínculo vive só na tabela
 * `funnel_bots`: `assignBots()` reescreve `funnel_bots` e **nunca toca**
 * `funnels.bot_id`.
 *
 * Enquanto este predicado olhava só a coluna, todo bot vinculado como
 * secundário era invisível para o runner — o funil existia, aparecia ativo na
 * interface e simplesmente não respondia. O sintoma relatado ("só funciona se
 * ficar reativando") é essa incoerência: reativar o funil pelo bot primário
 * funciona, pelos outros não, e a diferença não aparece em lugar nenhum.
 */
function belongsToBot(botId: string) {
  return or(
    eq(funnels.botId, botId),
    inArray(
      funnels.id,
      db.select({ id: funnelBots.funnelId }).from(funnelBots).where(eq(funnelBots.botId, botId)),
    ),
  );
}

// Handle de uma oferta dentro de um nó `offer`. O frontend usa exatamente
// `offer.callback || offer.product_name || offer_<i>` como id dos conectores
// (`<handle>__paid|__pending`) — replicamos para casar na retomada.
function offerHandleId(offer: Record<string, unknown>, i: number): string {
  const callback = typeof offer.callback === "string" ? offer.callback : "";
  const name     = typeof offer.product_name === "string" ? offer.product_name : "";
  return callback || name || `offer_${i}`;
}

// Coleta as ofertas "compráveis" de um nó com o handleId EXATO que o frontend usa
// nos conectores (`<handleId>__paid|__pending`). Cobre o nó `offer`
// dedicado (content.offers) e blocos de oferta dentro de um nó `message`
// (blocks[].offers, cujo fallback de handle é `offer_<blockIdx>_<offerIdx>`).
// A ordem do retorno é o índice usado no callback `offer:<i>`.
function collectNodeOffers(content: Record<string, unknown>): Array<{ offer: Record<string, unknown>; handleId: string }> {
  const out: Array<{ offer: Record<string, unknown>; handleId: string }> = [];
  const direct = content.offers as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(direct)) {
    direct.forEach((offer, i) => out.push({ offer, handleId: offerHandleId(offer, i) }));
  }
  const blocks = content.blocks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(blocks)) {
    blocks.forEach((block, blockIdx) => {
      if (block.type !== "offer") return;
      const offers = block.offers as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(offers)) return;
      offers.forEach((offer, offerIdx) => {
        const callback = typeof offer.callback === "string" ? offer.callback : "";
        const name     = typeof offer.product_name === "string" ? offer.product_name : "";
        out.push({ offer, handleId: callback || name || `offer_${blockIdx}_${offerIdx}` });
      });
    });
  }
  return out;
}

// Handle de um botão. O frontend usa `btn.callback || btn.text || btn_<i>` no nó
// `buttons` dedicado (ButtonsNode) e `btn.callback || btn.text ||
// btn_<blockIdx>_<btnIdx>` nos blocos de botões dentro de um nó `message`
// (MessageNode) — replicamos os dois para casar com node_connections.source_handle.
function buttonHandleId(btn: Record<string, unknown>, fallback: string): string {
  const callback = typeof btn.callback === "string" ? btn.callback : "";
  const text     = typeof btn.text === "string" ? btn.text : "";
  return callback || text || fallback;
}

// `callback_data` do Telegram tem limite de 1..64 BYTES — e o handleId pode ser o
// TEXTO do botão (17 emojis já estouram). Mandar o handleId cru fazia o
// sendMessage inteiro falhar (BUTTON_DATA_INVALID) e o texto do nó nem saía.
// Vai um id CURTO e estável por POSIÇÃO, resolvido de volta para o handleId no
// servidor quando o clique chega.
//
// O id carrega TAMBÉM a identidade do nó que emitiu o teclado. Sem ela um id
// posicional é chave-mestra: teclados antigos continuam vivos no chat e um
// `btn:0:0` existe em quase todo nó com botões, então um toque num teclado
// VELHO era resolvido contra o nó onde o lead está AGORA e o empurrava por um
// ramo que ele nunca escolheu (o "Não" do nó A virando o "Depois" do nó B).
//
// Formato ATUAL (o `<nó>` são os 8 primeiros caracteres alfanuméricos do uuid):
//   `b:<nó>:<i>`            → botão `i` do nó `buttons`
//   `b:<nó>:<bloco>:<i>`    → botão `i` do bloco `bloco` de um nó `message`
//   `o:<nó>:<i>`            → oferta `i` (nó `offer` ou bloco de oferta)
// Orçamento: 2 + 8 + 1 + índices → 18 bytes no pior caso realista (índices de 3
// dígitos), muito dentro dos 64.
function nodeScopeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}

function buttonCallbackId(nodeId: string, blockIdx: number | null, btnIdx: number): string {
  const scope = nodeScopeId(nodeId);
  return blockIdx === null ? `b:${scope}:${btnIdx}` : `b:${scope}:${blockIdx}:${btnIdx}`;
}

function offerCallbackId(nodeId: string, offerIdx: number): string {
  return `o:${nodeScopeId(nodeId)}:${offerIdx}`;
}

// Quebra um callback COM escopo (`b:`/`o:`) em { scope, parts }; `null` se não
// for do formato atual (aí é `btn:`/`offer:`/handle cru — sem nó embutido).
function parseScopedCallback(
  callbackData: string,
  prefix:       "b" | "o",
): { scope: string; parts: string[] } | null {
  if (!callbackData.startsWith(`${prefix}:`)) return null;
  const segs = callbackData.slice(prefix.length + 1).split(":");
  if (segs.length < 2 || !segs[0]) return null;
  return { scope: segs[0], parts: segs.slice(1) };
}

// Índice da oferta clicada DENTRO do nó em que o lead está parado.
//   `o:<nó>:<i>` (atual)  → só resolve se `<nó>` for este nó.
//   `offer:<i>` (legado)  → teclados já entregues antes deste deploy; posicional,
//                           sem identidade de nó — indecidível, resolve como antes.
// `foreign` = o clique veio comprovadamente de OUTRO nó → ignorar (senão o índice
// cairia numa oferta diferente e cobraria pelo produto errado).
function resolveOfferCallback(callbackData: string, nodeId: string): { index: number | null; foreign: boolean } {
  const toIdx = (s: string): number | null => (/^\d+$/.test(s) ? parseInt(s, 10) : null);
  const scoped = parseScopedCallback(callbackData, "o");
  if (scoped) {
    if (scoped.scope !== nodeScopeId(nodeId)) return { index: null, foreign: true };
    return { index: scoped.parts.length === 1 ? toIdx(scoped.parts[0]) : null, foreign: false };
  }
  return { index: toIdx(callbackData.slice("offer:".length)), foreign: false };
}

// Handles candidatos para um `callback_data` recebido, em ordem de prioridade.
//   • `b:<nó>:…` (formato ATUAL) → só resolve se `<nó>` for o nó em que o lead
//     está; caso contrário é clique em teclado velho (`foreign`) e não vale nada.
//     Dentro do nó certo a resolução é posicional: editar o texto do botão depois
//     de desenhar a aresta não quebra o casamento.
//   • `btn:<i>` / `btn:<bloco>:<i>` (formato anterior, ainda no chat de quem
//     recebeu antes deste deploy) → posicional, sem identidade de nó embutida: o
//     dono é indecidível e só resta resolver como antes.
//   • qualquer outro valor → ele próprio, formato ANTIGO (`callback_data` =
//     `btn.callback`/`btn.value`). Aqui a checagem de dono é implícita: `nextNode`
//     só procura arestas DESTE nó.
// `known` = o clique é de um botão DESTE nó (posição resolvida no conteúdo).
function resolveButtonCallback(
  content:      Record<string, unknown>,
  callbackData: string,
  nodeId:       string,
): { handles: string[]; known: boolean; foreign: boolean } {
  const handles: string[] = [];
  const add = (h: unknown): void => {
    if (typeof h === "string" && h && !handles.includes(h)) handles.push(h);
  };

  const scoped = parseScopedCallback(callbackData, "b");
  if (scoped && scoped.scope !== nodeScopeId(nodeId)) {
    return { handles: [], known: false, foreign: true };
  }

  const positional = scoped
    ? scoped.parts
    : callbackData.startsWith("btn:")
      ? callbackData.slice("btn:".length).split(":")
      : null;

  let known = false;
  if (positional) {
    const idx = positional.map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : -1));
    if (idx.length >= 1 && idx.length <= 2 && idx.every((n) => n >= 0)) {
      let btn: Record<string, unknown> | undefined;
      let fallback = "";
      if (idx.length === 1) {
        const btns = content.buttons as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(btns)) { btn = btns[idx[0]]; fallback = `btn_${idx[0]}`; }
      } else {
        const blocks = content.blocks as Array<Record<string, unknown>> | undefined;
        const block  = Array.isArray(blocks) ? blocks[idx[0]] : undefined;
        const btns   = block?.buttons as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(btns)) { btn = btns[idx[1]]; fallback = `btn_${idx[0]}_${idx[1]}`; }
      }
      if (btn && typeof btn === "object") {
        known = true;
        add(buttonHandleId(btn, fallback));
        // `callback`/`value` são campos do PRÓPRIO botão clicado, mas o VALOR pode
        // ser o handle de um IRMÃO (os defaults são `opt1`, `opt2`…): um botão sem
        // aresta cujo `value` é "opt2" casava com a aresta do irmão cujo `callback`
        // é "opt2" e mandava o lead pro ramo errado. Só entram como candidato os
        // valores que nenhum outro botão deste nó reivindica como handle seu.
        const clicked  = btn;
        const claimed  = new Set(
          collectNodeButtons(content).filter((b) => b.button !== clicked).map((b) => b.handleId),
        );
        const addOwn = (h: unknown): void => {
          if (typeof h === "string" && h && !claimed.has(h)) add(h);
        };
        addOwn(btn.callback); // aresta desenhada antes de o texto virar o handle
        addOwn(btn.value);    // formato pré-histórico do nó `buttons`
      }
    }
  }
  add(callbackData);
  return { handles, known, foreign: false };
}

// Coleta os botões CLICÁVEIS (os que ganham conector de FUNIL no editor) de um
// nó, com o handleId EXATO que o frontend usa. Cobre o nó `buttons` dedicado
// (content.buttons) e blocos de botões dentro de um nó `message` (blocks[].buttons).
//
// É a lista de quem POSSUI um handle no editor — serve para resolver a quem
// pertence um clique. NÃO serve para decidir se o nó pode parar esperando clique:
// para isso vale só o que de fato virou botão de callback para ESTE lead
// (`collectParkableButtons`).
function collectNodeButtons(content: Record<string, unknown>): Array<{ button: Record<string, unknown>; handleId: string }> {
  const out: Array<{ button: Record<string, unknown>; handleId: string }> = [];
  const push = (btn: Record<string, unknown>, fallback: string): void => {
    if (!btn || typeof btn !== "object") return;
    // `url` abre link e não volta como callback. `action: "offer"` é legado (o
    // editor atual só oferece Funil/Link): o conector dele é `<handle>__paid|
    // __pending` e a compra só dispara por `offer:<i>` — não há
    // aresta `<handle>` para casar, então ele NÃO pode segurar o nó.
    if (btn.action === "url" || btn.action === "offer") return;
    out.push({ button: btn, handleId: buttonHandleId(btn, fallback) });
  };

  const direct = content.buttons as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(direct)) direct.forEach((btn, i) => push(btn, `btn_${i}`));

  const blocks = content.blocks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(blocks)) {
    blocks.forEach((block, blockIdx) => {
      if (block.type !== "buttons") return;
      const btns = block.buttons as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(btns)) return;
      btns.forEach((btn, btnIdx) => push(btn, `btn_${blockIdx}_${btnIdx}`));
    });
  }
  return out;
}

// Como um botão de um bloco de botões (nó `message`) sai — ou não — no teclado
// DESTE lead. Predicado ÚNICO: o emissor (`blockButtonsKeyboard`) e o portão de
// parada (`collectParkableButtons`) chamam esta função, então é impossível o nó
// parar esperando um botão que o teclado não desenhou.
//
// Enquanto o portão olhava só `action`, um botão com handle ligado mas rótulo
// vazio (campo limpo, ou `{{nome}}` num lead sem nome) ou com `url` sobrando de
// quando era botão de link fazia o nó "esperar o clique" de um botão que nunca
// chegou ao Telegram — sem `no_click`, o lead ficava preso pra sempre.
type BlockButtonRender =
  | { kind: "callback"; label: string }
  | { kind: "url";      label: string; url: string }
  | { kind: "none" };

function renderBlockButton(btn: Record<string, unknown>, vars: Map<string, string>): BlockButtonRender {
  if (!btn || typeof btn !== "object") return { kind: "none" };
  const rawLabel = (btn.text ?? btn.label ?? "") as unknown;
  const label = typeof rawLabel === "string" && rawLabel ? interpolate(rawLabel, vars) : "";
  if (!label) return { kind: "none" };            // sem rótulo → linha nenhuma
  const url = typeof btn.url === "string" ? btn.url : "";
  if (btn.action === "url" || url) {
    // `url` (mesmo sobrando de um botão que virou "funil" sem limpar o campo)
    // manda o botão pro modo link: abre a URL e NUNCA volta como callback.
    return url ? { kind: "url", label, url } : { kind: "none" };
  }
  // `action: "offer"` (legado) fica de FORA: nunca houve caminho de compra para
  // ele aqui — desenhá-lo daria um botão morto.
  if (btn.action === "offer") return { kind: "none" };
  return { kind: "callback", label };
}

// Cor do botão — suportada pelo Telegram desde o Bot API 9.4 (fev/2026):
// `style` em InlineKeyboardButton, só "primary"|"success"|"danger". A paleta
// do editor (buttonStyle.ts, no front) tem 4 opções porque também cobre
// "warning" — sem equivalente no Telegram, então cai em undefined (omitido =
// estilo padrão do app do lead, igual a nunca ter tido cor nenhuma).
function telegramButtonStyle(style: unknown): "primary" | "success" | "danger" | undefined {
  if (style === "primary") return "primary";
  if (style === "constructive") return "success";
  if (style === "destructive") return "danger";
  return undefined;
}

// Teclado inline dos blocos de botões de um nó `message`. Botões de link viram
// linha `url`; os demais mandam o id curto COM ESCOPO DE NÓ como `callback_data`.
function blockButtonsKeyboard(
  content: Record<string, unknown>,
  vars:    Map<string, string>,
  nodeId:  string,
): Array<Array<Record<string, unknown>>> {
  const rows: Array<Array<Record<string, unknown>>> = [];
  const blocks = content.blocks as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(blocks)) return rows;

  blocks.forEach((block, blockIdx) => {
    if (block.type !== "buttons") return;
    const btns = block.buttons as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(btns)) return;
    btns.forEach((btn, btnIdx) => {
      const r = renderBlockButton(btn, vars);
      const style = telegramButtonStyle(btn?.style);
      if (r.kind === "url") rows.push([{ text: r.label, url: r.url, ...(style ? { style } : {}) }]);
      else if (r.kind === "callback") {
        rows.push([{ text: r.label, callback_data: buttonCallbackId(nodeId, blockIdx, btnIdx), ...(style ? { style } : {}) }]);
      }
    });
  });
  return rows;
}

// Botões de um nó `message` que REALMENTE chegam ao Telegram como botão de
// callback para este lead — a única lista com que o nó pode parar e esperar o
// clique. Mesmo predicado do emissor, mesma interpolação, mesmo lead.
function collectParkableButtons(
  content: Record<string, unknown>,
  vars:    Map<string, string>,
): Array<{ button: Record<string, unknown>; handleId: string }> {
  const out: Array<{ button: Record<string, unknown>; handleId: string }> = [];
  const blocks = content.blocks as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(blocks)) return out;

  blocks.forEach((block, blockIdx) => {
    if (block.type !== "buttons") return;
    const btns = block.buttons as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(btns)) return;
    btns.forEach((btn, btnIdx) => {
      if (renderBlockButton(btn, vars).kind !== "callback") return;
      out.push({ button: btn, handleId: buttonHandleId(btn, `btn_${blockIdx}_${btnIdx}`) });
    });
  });
  return out;
}

// Tempo (em segundos) do timeout "sem clique" de um nó com botões. Fica em
// `content.no_click_timeout_seconds` (nó `buttons`) ou no bloco de botões
// (`blocks[].no_click_timeout_seconds`, nó `message`). Ausente/<=0 → sem timeout.
function noClickTimeoutSeconds(content: Record<string, unknown>): number {
  const direct = content.no_click_timeout_seconds;
  if (typeof direct === "number" && direct > 0) return direct;
  const blocks = content.blocks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block.type !== "buttons") continue;
      const v = block.no_click_timeout_seconds;
      if (typeof v === "number" && v > 0) return v;
    }
  }
  return 0;
}

// `sale_type` de uma compra no flow. O tipo vive no NÓ (`content.offer_kind`,
// gravado pelo FunnelEditor: "upsell" | "downsell"; ausente/"main" = oferta
// principal). Ofertas embutidas num nó `message` não têm kind → "offer".
function saleTypeFromNodeContent(content: Record<string, unknown> | null | undefined): SaleType {
  const kind = typeof content?.offer_kind === "string" ? content.offer_kind : "main";
  switch (kind) {
    case "upsell":     return "upsell";
    case "downsell":   return "downsell";
    case "order_bump": return "order_bump";
    default:           return "offer";
  }
}

interface ExecutionContext {
  botId:  string;
  update: TelegramUpdate;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Texto dos nós é plano (textarea), mas o Telegram usa parse_mode HTML por padrão.
// Sem escapar, um `<`, `>` ou `&` no texto faz o Telegram rejeitar e abortar o passo.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Envia o indicador "digitando…"/"gravando áudio…" e PAUSA antes do envio real.
// Sem a pausa, o indicador some no mesmo instante que a mensagem chega (parecia
// "não funcionar"). Duração proporcional ao tamanho do texto: 900ms–4s (o
// indicador do Telegram expira em ~5s, então não passamos disso). O processamento
// é assíncrono (fora do webhook), então pausar aqui é seguro.
async function simulateAction(
  tg: TelegramClient, chatId: string,
  typing: boolean, recording: boolean, text?: string,
): Promise<void> {
  if (!typing && !recording) return;
  await tg.sendChatAction(chatId, recording ? "record_voice" : "typing");
  const len = text?.length ?? 40;
  const ms = Math.min(4000, Math.max(900, len * 35));
  await sleep(ms);
}

// ── Validação de input ─────────────────────────────────────────────────────────
// O frontend (NodeEditPanel) salva `content.validation` com os valores:
// "none" | "email" | "number" | "cpf". Tratamos também sinônimos (numeric,
// telefone/phone, etc.) por segurança. Qualquer valor desconhecido → sem validação.

// Remove acentos e normaliza p/ comparação case-insensitive.
function normalizeValidationKind(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function isValidNumber(s: string): boolean {
  // inteiro ou decimal com . ou , (opcionalmente com sinal)
  return /^[+-]?\d+([.,]\d+)?$/.test(s.trim());
}

function isValidPhone(s: string): boolean {
  // 10–13 dígitos, ignorando separadores comuns (+, -, espaços, parênteses)
  const digits = s.replace(/[^\d]/g, "");
  return digits.length >= 10 && digits.length <= 13;
}

function isValidCpf(s: string): boolean {
  const cpf = s.replace(/[^\d]/g, "");
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos os dígitos iguais

  const calcDigit = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(cpf[i], 10) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calcDigit(9) === parseInt(cpf[9], 10) && calcDigit(10) === parseInt(cpf[10], 10);
}

// Retorna true se `value` passa na validação `kind`. Tipos desconhecidos/none → true.
function passesValidation(kind: unknown, value: string): boolean {
  const k = normalizeValidationKind(kind);
  switch (k) {
    case "email":   return isValidEmail(value);
    case "number":
    case "numero":
    case "numeric": return isValidNumber(value);
    case "cpf":     return isValidCpf(value);
    case "telefone":
    case "phone":   return isValidPhone(value);
    default:        return true; // none/"" /desconhecido → sem validação
  }
}

async function getVars(leadId: string, botId: string): Promise<Map<string, string>> {
  const rows = await db.select().from(leadVariables)
    .where(and(eq(leadVariables.leadId, leadId), eq(leadVariables.botId, botId)));
  const map = new Map(rows.map((r) => [r.variableName, r.value]));
  // Injeta campos nativos do lead ({{first_name}}, {{username}}, ...) sem
  // sobrescrever variáveis já salvas pelo usuário.
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (lead) mergeLeadFields(map, lead);
  return map;
}

async function setVar(leadId: string, botId: string, name: string, value: string): Promise<void> {
  await db.insert(leadVariables).values({ leadId, botId, variableName: name, value })
    .onConflictDoUpdate({
      target: [leadVariables.leadId, leadVariables.variableName],
      set:    { value, updatedAt: new Date() },
    });
}

async function saveOutbound(leadId: string, botId: string, content: Record<string, unknown>): Promise<void> {
  await db.insert(leadMessages).values({ leadId, botId, direction: "outbound", content });
}

async function saveInbound(leadId: string, botId: string, content: Record<string, unknown>): Promise<void> {
  await db.insert(leadMessages).values({ leadId, botId, direction: "inbound", content });
}

// Próximo nó a partir de uma saída do nó atual.
//
// COM `sourceHandle`: casa a aresta por igualdade EXATA (é o contrato dos
// conectores nomeados: `<handle>__paid`, "true"/"false", "no_response", ...).
//
// SEM `sourceHandle` (avanço genérico, "caiu do nó pra baixo"): usa SÓ a aresta
// da saída genérica — `source_handle IS NULL`. Antes a consulta ignorava a
// coluna e pegava uma aresta QUALQUER (sem ORDER BY), então um nó de mensagem
// com blocos de botões/oferta era despachado por um conector de botão ao acaso
// e o lead pulava para o ramo errado. Nenhum nó depende do comportamento antigo:
// a saída genérica do editor (handle inferior do FlowNodeShell) é sempre salva
// com handle NULL, e todo handle nomeado tem semântica própria (botão, oferta,
// condição, random, wait_response) que jamais deve ser tomada "de graça".
// `ORDER BY created_at, id` só para ser determinístico se houver duplicatas.
async function nextNode(funnelId: string, sourceNodeId: string, sourceHandle?: string): Promise<string | null> {
  const base = and(eq(nodeConnections.funnelId, funnelId), eq(nodeConnections.sourceNodeId, sourceNodeId));
  const conditions = sourceHandle
    ? and(base, eq(nodeConnections.sourceHandle, sourceHandle))
    : and(base, isNull(nodeConnections.sourceHandle));
  const [conn] = await db.select().from(nodeConnections)
    .where(conditions)
    .orderBy(nodeConnections.createdAt, nodeConnections.id)
    .limit(1);
  return conn?.targetNodeId ?? null;
}

// Handles de saída do nó que TÊM aresta desenhada (a saída genérica, cujo
// `source_handle` é NULL, fica de fora de propósito). Serve para decidir se um nó
// com botões pode mesmo segurar o lead ou se ele viraria um beco sem saída.
async function connectedHandles(funnelId: string, nodeId: string): Promise<Set<string>> {
  const rows = await db.select({ handle: nodeConnections.sourceHandle })
    .from(nodeConnections)
    .where(and(eq(nodeConnections.funnelId, funnelId), eq(nodeConnections.sourceNodeId, nodeId)));
  return new Set(rows.map((r) => r.handle).filter((h): h is string => typeof h === "string" && h.length > 0));
}

async function advanceProgress(progressId: string, nodeId: string | null, status: string): Promise<void> {
  await db.update(leadProgress).set({ currentNodeId: nodeId, status, updatedAt: new Date() })
    .where(eq(leadProgress.id, progressId));
}

// ── Main use case ─────────────────────────────────────────────────────────────

export class ExecuteFlowStepUseCase {
  async execute(ctx: ExecutionContext): Promise<void> {
    const { botId, update } = ctx;

    // ── Bot adicionado/removido de grupo/canal (my_chat_member) ─────────────
    if (update.my_chat_member) {
      await this.handleChatMemberEvent(botId, update.my_chat_member);
      return;
    }

    // Identify sender + message text
    const from = update.message?.from ?? update.callback_query?.from;
    if (!from) return;

    const chatId = BigInt(update.message?.chat.id ?? from.id);
    const messageText = update.message?.text ?? null;
    const callbackData = update.callback_query?.data ?? null;
    const callbackQueryId = update.callback_query?.id ?? null;

    // Get bot token (for Telegram API calls)
    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) return;
    const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatIdStr = chatId.toString();

    // ── Migração grupo→supergrupo: o chat ganha ID novo e o antigo morre.
    //    Remapeia o registro salvo para o ID novo (em vez de deixar os dois).
    if (update.message?.migrate_to_chat_id) {
      await this.handleGroupMigration(botId, BigInt(update.message.chat.id), BigInt(update.message.migrate_to_chat_id));
      return;
    }
    if (update.message?.migrate_from_chat_id) {
      await this.handleGroupMigration(botId, BigInt(update.message.migrate_from_chat_id), BigInt(update.message.chat.id));
      return;
    }

    // ── Mensagens em grupo/canal: `/id` salva o grupo e devolve o ID; as
    //    demais são ignoradas (nunca registrar um grupo como lead) ──────────
    const inboundChatType = update.message?.chat.type;
    if (inboundChatType && inboundChatType !== "private") {
      if (typeof messageText === "string" && messageText.trim().startsWith("/id")) {
        await this.handleIdCommand(botId, update.message!.chat.id, inboundChatType, tg);
      }
      return;
    }

    // Upsert lead
    const [lead] = await db.insert(leads).values({
      botId,
      telegramChatId:   chatId,
      telegramUsername: from.username ?? null,
      firstName:        from.first_name ?? null,
      lastName:         (from as { last_name?: string }).last_name ?? null,
    }).onConflictDoUpdate({
      target: [leads.botId, leads.telegramChatId],
      set: {
        telegramUsername: from.username ?? null,
        firstName:        from.first_name ?? null,
        lastName:         (from as { last_name?: string }).last_name ?? null,
        updatedAt:        new Date(),
      },
    }).returning();

    // Save inbound message
    if (messageText) {
      await saveInbound(lead.id, botId, { kind: "text", text: messageText });
    }

    // Registra o /start como evento. Fica ANTES do roteamento (fluxo vs
    // simplificado) para contar os dois. `leads` só guarda uma linha por chat,
    // então sem isto não há como saber quantas vezes alguém deu /start.
    // Deep link ("/start ref123") também conta.
    if (typeof messageText === "string" && /^\/start(\s|$)/.test(messageText)) {
      await db.insert(leadEvents).values({ botId, leadId: lead.id, kind: "start" });

      // Deep link com rastreamento: "/start tk_<token>" (tráfego pago, resolve
      // o clique salvo pelo /r) ou "/start src_x__m_y" (orgânico, UTMs no
      // próprio payload). Grava UTMs/click ids no lead; nunca lança.
      const startPayload = messageText.slice("/start".length).trim();
      if (startPayload) await applyStartTracking(lead.id, startPayload);

      // Pixels: evento Lead no PRIMEIRO /start (o registro que acabou de entrar
      // é o nº 1). Roda depois do applyStartTracking, para o payload do clique
      // (fbc, ttclid, kwai clickid) já estar no lead quando o dispatcher enviar.
      const [startCount] = await db.select({ n: sql<number>`count(*)::int` })
        .from(leadEvents)
        .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.kind, "start")));
      if (Number(startCount?.n ?? 0) === 1) {
        await enqueuePixelEvents(botId, "Lead", { leadId: lead.id });
      }
    }

    // Answer callback immediately to stop Telegram spinner
    if (callbackQueryId) {
      await tg.answerCallbackQuery({ callbackQueryId }).catch(() => {});
    }

    // ── Compra via botão de OFERTA de broadcast/remarketing (bcast_buy_<id>) ──
    if (callbackData && callbackData.startsWith("bcast_buy_")) {
      await this.handleBroadcastBuy(callbackData.slice("bcast_buy_".length), lead, bot, chatIdStr, tg);
      return;
    }

    // Check if lead is manually paused — drop all automation
    const [prog] = await db.select().from(leadProgress)
      .where(eq(leadProgress.leadId, lead.id));
    if (prog?.status === "paused_manual") return;

    const vars = await getVars(lead.id, botId);

    // ── Funil SIMPLIFICADO tem precedência (interpretador linear, stateless) ──
    const [simplifiedFunnel] = await db.select().from(funnels)
      .where(and(belongsToBot(botId), eq(funnels.isActive, true), eq(funnels.kind, "simplified")))
      .orderBy(desc(funnels.updatedAt))
      .limit(1);
    if (simplifiedFunnel) {
      const handled = await simplifiedUseCase.handle({
        bot, lead, chatId: chatIdStr, funnel: simplifiedFunnel,
        text: messageText, callbackData,
        callbackMessageId: update.callback_query?.message?.message_id ?? null,
        tg,
      });
      if (handled) return;
    }

    // ── /start command: enter funnel ────────────────────────────────────────
    // Cobre também deep links ("/start tk_..." do tráfego pago, "/start src_..."
    // do orgânico): antes só o "/start" seco reiniciava o funil de um lead com
    // progresso — quem voltava por um link rastreado ficava sem resposta.
    const isStartCommand = typeof messageText === "string" && /^\/start(\s|$)/.test(messageText);
    if (isStartCommand || !prog) {
      // Só funis de fluxo são executáveis aqui (o simplificado não tem nós).
      // orderBy + limit p/ ser determinístico quando há mais de um ativo.
      const [activeFunnel] = await db.select().from(funnels)
        .where(and(
          belongsToBot(botId),
          eq(funnels.isActive, true),
          ne(funnels.kind, "simplified"),
        ))
        .orderBy(desc(funnels.updatedAt))
        .limit(1);
      if (!activeFunnel) return;

      // Find trigger node
      const [triggerNode] = await db.select().from(funnelNodes)
        .where(and(eq(funnelNodes.funnelId, activeFunnel.id), eq(funnelNodes.type, "trigger")));
      if (!triggerNode) return;

      // Create or replace progress
      if (prog) {
        // Recomeço reaproveita o MESMO progressId, então qualquer delay pendente
        // (o "sem clique" do nó onde o lead estava, o timeout de "sem ação" de
        // uma oferta, um nó `delay`) ficaria órfão e depois arrancaria o lead
        // do funil recomeçado. Cancela antes de reposicionar no trigger.
        await db.delete(scheduledDelays).where(and(
          eq(scheduledDelays.progressId, prog.id),
          eq(scheduledDelays.status, "pending"),
        ));
        await db.update(leadProgress)
          .set({ funnelId: activeFunnel.id, currentNodeId: triggerNode.id, status: "active", updatedAt: new Date() })
          .where(eq(leadProgress.id, prog.id));
      } else {
        await db.insert(leadProgress).values({
          leadId:        lead.id,
          funnelId:      activeFunnel.id,
          currentNodeId: triggerNode.id,
          status:        "active",
        });
      }

      // Execute from the node AFTER the trigger
      const afterTriggerId = await nextNode(activeFunnel.id, triggerNode.id);
      if (afterTriggerId) {
        const [newProg] = await db.select().from(leadProgress).where(eq(leadProgress.leadId, lead.id));
        await this.runNode(activeFunnel.id, afterTriggerId, newProg.id, lead.id, botId, chatIdStr, tg, bot.protectContent, vars, null);
      }
      return;
    }

    // ── Handle button callback ───────────────────────────────────────────────
    if (callbackData && prog) {
      const currentNode = prog.currentNodeId
        ? (await db.select().from(funnelNodes).where(eq(funnelNodes.id, prog.currentNodeId)))[0]
        : null;

      // Clique num botão de compra (callback `o:<nó>:<i>`, curto p/ caber no limite
      // de 64 bytes do TG; `offer:<i>` é o formato legado). Funciona no nó `offer`
      // dedicado E em ofertas embutidas num nó `message` — o índice é resolvido pela
      // mesma ordem de collectNodeOffers.
      if (currentNode && (callbackData.startsWith("offer:") || callbackData.startsWith("o:"))) {
        const { index, foreign } = resolveOfferCallback(callbackData, currentNode.id);
        // Teclado de oferta de OUTRO nó (o lead rolou o chat e tocou num botão
        // antigo): o índice cairia numa oferta diferente e geraria PIX do produto
        // errado. O callback já foi respondido lá em cima — aqui nada acontece.
        if (foreign) return;
        const offersList = collectNodeOffers(currentNode.content as Record<string, unknown>);
        const picked = index !== null ? offersList[index] : undefined;
        if (picked) {
          await this.handleOfferPurchase(picked.offer, picked.handleId, currentNode, prog, lead, bot, chatIdStr, tg);
        }
        return;
      }

      // Clique num botão de funil. Vale para o nó `buttons` dedicado E para
      // blocos de botões dentro de um nó `message`.
      const nodeContent = (currentNode?.content ?? {}) as Record<string, unknown>;
      const nodeButtons = currentNode ? collectNodeButtons(nodeContent) : [];
      if (currentNode && (currentNode.type === "buttons" || nodeButtons.length > 0)) {
        // `callback_data` atual é o id curto com escopo do nó; os antigos eram o
        // id posicional sem escopo e o próprio handle. Candidatos em ordem.
        const { handles, known, foreign } = resolveButtonCallback(nodeContent, callbackData, currentNode.id);
        // Clique num teclado que pertence COMPROVADAMENTE a outro nó (o lead
        // rolou o chat e tocou num botão antigo). Ele não pilota o nó atual: o
        // callback já foi respondido, o spinner some e nada mais acontece.
        if (foreign) return;
        let nextId: string | null = null;
        for (const handle of handles) {
          nextId = await nextNode(prog.funnelId, currentNode.id, handle);
          if (nextId) break;
        }

        // Botão sem aresta num nó de MENSAGEM (handle órfão: o texto do botão foi
        // editado depois de a aresta ser desenhada). Antes desta feature o nó nem
        // parava — ia embora pela saída genérica; mantemos essa saída para o
        // clique não virar beco sem saída. Só quando o clique é comprovadamente
        // DESTE nó, para um toque em teclado velho não empurrar o lead adiante.
        const ownsClick = known || nodeButtons.some((b) => b.handleId === callbackData);
        if (!nextId && currentNode.type === "message" && ownsClick) {
          nextId = await nextNode(prog.funnelId, currentNode.id);
        }

        if (nextId) {
          // Só agora cancela o timeout "sem clique" pendente: se o clique não
          // levou a lugar nenhum, o único escape do lead continua armado.
          await db.delete(scheduledDelays).where(and(
            eq(scheduledDelays.progressId, prog.id),
            eq(scheduledDelays.status, "pending"),
          ));
          await advanceProgress(prog.id, nextId, "active");
          await this.runNode(prog.funnelId, nextId, prog.id, lead.id, botId, chatIdStr, tg, bot.protectContent, vars, null);
        }
        return;
      }
    }

    // ── Handle text response for input node ─────────────────────────────────
    if (messageText && prog) {
      const currentNode = prog.currentNodeId
        ? (await db.select().from(funnelNodes).where(eq(funnelNodes.id, prog.currentNodeId)))[0]
        : null;

      if (currentNode?.type === "input" || currentNode?.type === "wait_response") {
        const c = currentNode.content as {
          variable_name?: string;
          validation?:    string;
          error_message?: string;
        };

        // 1) Validação de input: se houver `validation` configurado e a resposta
        //    for inválida, reenvia a mensagem de erro e PERMANECE no nó (não salva
        //    variável nem avança). Sem validation (ou tipo desconhecido) → segue.
        if (!passesValidation(c.validation, messageText)) {
          const errRaw = c.error_message ?? "Resposta inválida. Tente novamente.";
          const errText = escapeHtml(interpolate(errRaw, vars));
          await tg.sendMessage({ chatId: chatIdStr, text: errText, protectContent: bot.protectContent });
          await saveOutbound(lead.id, botId, { kind: "text", text: errText, nodeId: currentNode.id });
          return; // fica no mesmo nó esperando nova resposta
        }

        if (c.variable_name) {
          await setVar(lead.id, botId, c.variable_name, messageText);
          vars.set(c.variable_name, messageText);
        }

        // 2) Resolução do próximo nó:
        //    - wait_response: cancela timeouts pendentes deste progresso e avança
        //      pelo handle "responded" (fallback p/ a conexão default).
        //    - input: comportamento atual (conexão default).
        let nextId: string | null;
        if (currentNode.type === "wait_response") {
          await db.delete(scheduledDelays).where(and(
            eq(scheduledDelays.progressId, prog.id),
            eq(scheduledDelays.status, "pending"),
          ));
          nextId = await nextNode(prog.funnelId, currentNode.id, "responded")
                ?? await nextNode(prog.funnelId, currentNode.id);
        } else {
          nextId = await nextNode(prog.funnelId, currentNode.id);
        }

        if (nextId) {
          await advanceProgress(prog.id, nextId, "active");
          await this.runNode(prog.funnelId, nextId, prog.id, lead.id, botId, chatIdStr, tg, bot.protectContent, vars, null);
        }
      }
    }
  }

  // ── Grupo/canal: bot virou (ou deixou de ser) membro/admin ──────────────────
  private async handleChatMemberEvent(botId: string, ev: TelegramChatMemberUpdated): Promise<void> {
    const status = ev.new_chat_member?.status;
    const isBot  = ev.new_chat_member?.user?.is_bot;
    const type   = ev.chat?.type;
    if (!isBot || (type !== "group" && type !== "supergroup" && type !== "channel")) return;

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot || !bot.isActive) return;
    const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatId = ev.chat.id;

    // Removido/saiu → remove do sistema.
    if (status === "left" || status === "kicked") {
      await db.delete(botGroups).where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, BigInt(chatId))));
      return;
    }

    // Só salva quando o bot vira ADMIN. Entrar como membro comum não registra:
    // além de inútil pra VIP (sem permissão de convite), adicionar como membro
    // e promover depois gerava registro duplicado quando o Telegram migrava o
    // grupo básico para supergrupo (id novo).
    if (status === "administrator") {
      const isChannel = type === "channel";
      const label = isChannel ? "Canal" : "Grupo";
      const info = await tg.getChat(String(chatId));
      const name = info?.title || label;
      await this.upsertGroup(botId, BigInt(chatId), name, type);

      const permissionNote = isChannel
        ? `permissão de "<b>Postar mensagens</b>"`
        : `permissão de "<b>Banir usuários</b>"`;
      const msg = `✅ <b>Bot adicionado com sucesso!</b>\n\nPara usar este ${label.toLowerCase()} como ${label.toLowerCase()} VIP:\n\n1️⃣ Certifique-se de que o bot tem ${permissionNote}\n2️⃣ No painel, vá em <b>Produtos</b> e crie um produto do tipo "<b>${label} VIP</b>"\n3️⃣ Cole o ID no campo "ID do Grupo Telegram"\n\n🆔 <b>ID deste ${label.toLowerCase()}:</b> <code>${chatId}</code>`;
      await tg.sendMessage({ chatId: String(chatId), text: msg, protectContent: false }).catch(() => {});
    }
  }

  // ── Comando `/id` em grupo/canal: salva e devolve o ID ──────────────────────
  private async handleIdCommand(botId: string, chatId: number, type: string, tg: TelegramClient): Promise<void> {
    const label = type === "channel" ? "Canal" : "Grupo";
    const info  = await tg.getChat(String(chatId));
    const name  = info?.title || label;
    await this.upsertGroup(botId, BigInt(chatId), name, type);
    const msg = `🆔 <b>ID deste ${label.toLowerCase()}:</b> <code>${chatId}</code>\n\n✅ ${label} salvo automaticamente no painel.`;
    await tg.sendMessage({ chatId: String(chatId), text: msg, protectContent: false }).catch(() => {});
  }

  // Migração grupo→supergrupo: atualiza o registro antigo IN-PLACE para o id
  // novo (preserva o uuid da linha — ofertas VIP que referenciam bot_groups.id
  // continuam válidas). Se o supergrupo já foi salvo em outra linha, funde as
  // duas mantendo a antiga.
  private async handleGroupMigration(botId: string, oldChatId: bigint, newChatId: bigint): Promise<void> {
    const [oldRow] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, oldChatId)));
    const [newRow] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, newChatId)));

    if (!oldRow) return; // nada salvo com o id antigo — nada a remapear

    let name = oldRow.name;
    if (newRow) {
      // Funde: repoint das ofertas que apontam pra linha nova → linha antiga,
      // apaga a duplicada e herda o nome mais recente.
      await db.update(funnelOffers).set({ telegramGroupId: oldRow.id })
        .where(eq(funnelOffers.telegramGroupId, newRow.id));
      await db.delete(botGroups).where(eq(botGroups.id, newRow.id));
      name = newRow.name;
    }

    await db.update(botGroups)
      .set({ telegramChatId: newChatId, type: "supergroup", name, updatedAt: new Date() })
      .where(eq(botGroups.id, oldRow.id));
    console.log(`[runner] grupo migrado p/ supergrupo: ${oldChatId} → ${newChatId} (bot ${botId})`);
  }

  // Upsert de grupo por (botId, telegramChatId) — sem depender de constraint única.
  private async upsertGroup(botId: string, chatId: bigint, name: string, type: string): Promise<void> {
    const [existing] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, chatId)));
    if (existing) {
      await db.update(botGroups).set({ name, type, updatedAt: new Date() }).where(eq(botGroups.id, existing.id));
    } else {
      await db.insert(botGroups).values({ botId, telegramChatId: chatId, name, type });
    }
  }

  // ── Public: resume from a specific node (used by delay processor) ───────────

  async resumeFromNode(
    funnelId:   string,
    nodeId:     string,
    progressId: string,
    leadId:     string,
    botId:      string,
    chatId:     string,
    tg:         TelegramClient,
    protect:    boolean,
    vars:       Map<string, string>,
  ): Promise<void> {
    // Guarda conservadora contra delay ÓRFÃO: o progresso pode ter sido apagado
    // ou ter mudado de funil (o lead deu /start e caiu noutro funil ativo) entre
    // o agendamento e o vencimento. Só o FUNIL é verificado — o nó atual não
    // serve de referência porque o nó `delay` grava `current_node_id = NULL` de
    // propósito enquanto espera, e é justamente ele que retoma por aqui.
    const [progress] = await db.select().from(leadProgress).where(eq(leadProgress.id, progressId));
    if (!progress || progress.funnelId !== funnelId) return;
    await this.runNode(funnelId, nodeId, progressId, leadId, botId, chatId, tg, protect, vars, null);
  }

  // ── Node runner ─────────────────────────────────────────────────────────────

  private async runNode(
    funnelId:       string,
    nodeId:         string,
    progressId:     string,
    leadId:         string,
    botId:          string,
    chatId:         string,
    tg:             TelegramClient,
    protect:        boolean,
    vars:           Map<string, string>,
    _parentNodeId:  string | null,
    depth = 0,
  ): Promise<void> {
    if (depth > 50) return; // prevent infinite loops

    const [node] = await db.select().from(funnelNodes).where(eq(funnelNodes.id, nodeId));
    if (!node) return;

    const c = node.content as Record<string, unknown>;
    await advanceProgress(progressId, node.id, "active");

    switch (node.type) {
      case "message": {
        await this.executeMessageNode(c, chatId, tg, protect, vars, node.id);
        await saveOutbound(leadId, botId, { ...c, nodeId: node.id });
        // Nó de mensagem pode conter blocos de oferta (botões de compra). Se houver,
        // comporta-se como nó offer: apresenta as ofertas, espera o clique e agenda
        // o timeout de "sem ação" (ramo __pending) — não avança automaticamente.
        const msgOffers = collectNodeOffers(c);
        if (msgOffers.length > 0) {
          await this.presentOffers(c, msgOffers, chatId, tg, protect, vars, node.id);
          await advanceProgress(progressId, node.id, "active");
          await this.scheduleOfferTimeouts(funnelId, node, progressId, leadId, botId, "no_action");
          return;
        }
        // Bloco de BOTÕES dentro do nó de mensagem: o teclado inline já foi
        // enviado por executeMessageNode; agora o nó se comporta como o nó
        // `buttons` dedicado — PARA aqui e espera o clique (antes caía no avanço
        // genérico e o lead era despachado por um conector de botão ao acaso).
        //
        // MAS só para se houver por onde SAIR: pelo menos um botão com aresta, ou
        // o escape "sem clique" (tempo configurado + aresta no handle `no_click`).
        // Funis salvos ANTES desta correção têm blocos de botões cujos handles
        // nunca foram ligados (os botões simplesmente não funcionavam) e só a
        // aresta genérica embaixo — parar neles seria um beco sem saída
        // permanente. Sem saída de botão, seguimos pelo avanço genérico, exatamente
        // como antes.
        //
        // A lista é a dos botões que ESTE lead recebeu de fato (mesmo predicado do
        // teclado): botão de rótulo vazio ou com `url` sobrando não desenha nada,
        // e parar esperando o clique dele prendia o lead pra sempre.
        const msgButtons = collectParkableButtons(c, vars);
        if (msgButtons.length > 0) {
          const wiredHandles = await connectedHandles(funnelId, node.id);
          const anyButtonWired = msgButtons.some(({ handleId }) => wiredHandles.has(handleId));
          const noClickEscape  = noClickTimeoutSeconds(c) > 0 && wiredHandles.has("no_click");
          if (anyButtonWired || noClickEscape) {
            await advanceProgress(progressId, node.id, "active");
            await this.scheduleNoClickTimeout(funnelId, node, progressId, leadId, botId);
            return;
          }
        }
        break;
      }

      case "media":
        // O painel oferece o toggle de simulação também no nó de mídia
        // (NodeEditPanel, aba do nó `media`) — sem isto a flag era salva e ignorada.
        await simulateAction(tg, chatId, !!c.simulate_typing, !!c.simulate_recording,
          typeof c.caption === "string" ? c.caption : undefined);
        await this.executeMediaNode(c, chatId, tg, protect, vars);
        await saveOutbound(leadId, botId, { ...c, nodeId: node.id });
        break;

      case "audio": {
        const url     = c.url as string | undefined;
        const caption = typeof c.caption === "string" ? interpolate(c.caption, vars) : undefined;
        // Áudio: por padrão simula "gravando áudio…" (a não ser que o nó desligue).
        await simulateAction(tg, chatId, !!c.simulate_typing, c.simulate_recording !== false, undefined);
        if (url) await tg.sendAudio(chatId, url, caption, protect);
        await saveOutbound(leadId, botId, { kind: "audio", url, nodeId: node.id });
        break;
      }

      case "buttons":
        // Idem para o nó de botões — o toggle existe no painel desde sempre.
        await simulateAction(tg, chatId, !!c.simulate_typing, !!c.simulate_recording,
          typeof c.message === "string" ? c.message : undefined);
        await this.executeButtonsNode(c, chatId, tg, protect, vars, node.id);
        await saveOutbound(leadId, botId, { ...c, nodeId: node.id });
        // Stay on this node waiting for callback
        await advanceProgress(progressId, node.id, "active");
        // Se o lead não clicar em nada, dispara o ramo `no_click` (opcional).
        await this.scheduleNoClickTimeout(funnelId, node, progressId, leadId, botId);
        return;

      case "input":
      case "wait_response": {
        // Stay on this node; next step triggered by inbound message.
        // O frontend salva a pergunta em `question`; fallback p/ `prompt` antigo.
        await advanceProgress(progressId, node.id, "active");
        const promptRaw = (c.question ?? c.prompt) as string | undefined;
        if (promptRaw) {
          const prompt = escapeHtml(interpolate(promptRaw, vars));
          await tg.sendMessage({ chatId, text: prompt, protectContent: protect });
          await saveOutbound(leadId, botId, { kind: "text", text: prompt, nodeId: node.id });
        }

        // Timeout do wait_response: o frontend salva `timeout_seconds` (em segundos)
        // e liga o nó pelos handles "responded" e "no_response". Se houver timeout
        // e um alvo no_response, agenda em scheduled_delays p/ o scheduler existente
        // (runner.ts) rodar o ramo no_response quando vencer. Sem timeout ou sem
        // alvo → não agenda (espera indefinidamente, como antes).
        if (node.type === "wait_response") {
          const timeoutSeconds = typeof c.timeout_seconds === "number" ? c.timeout_seconds : 0;
          if (timeoutSeconds > 0) {
            const noResponseId = await nextNode(funnelId, node.id, "no_response");
            if (noResponseId) {
              await db.insert(scheduledDelays).values({
                botId,
                leadId,
                funnelId,
                progressId,
                nextNodeId: noResponseId,
                executeAt:  new Date(Date.now() + timeoutSeconds * 1000),
                status:     "pending",
              });
            }
          }
        }
        return;
      }

      case "delay": {
        // Frontend salva `seconds`; fallback p/ o par value/unit antigo.
        let seconds: number;
        if (typeof c.seconds === "number") {
          seconds = c.seconds;
        } else {
          const value = (c.value as number) ?? 0;
          const unit  = (c.unit as string) ?? "seconds";
          seconds = unit === "minutes" ? value * 60 : unit === "hours" ? value * 3600 : value;
        }
        const ms     = seconds * 1000;
        const nextId = await nextNode(funnelId, node.id);
        // "digitando…"/"gravando…" durante a espera (o indicador do Telegram
        // expira em ~5s, então cobre bem delays curtos, que é o caso de uso).
        if (c.simulate_typing || c.simulate_recording) {
          await tg.sendChatAction(chatId, c.simulate_recording ? "record_voice" : "typing");
        }
        if (nextId && ms > 0) {
          await db.insert(scheduledDelays).values({
            botId,
            leadId,
            funnelId,
            progressId,
            nextNodeId: nextId,
            executeAt:  new Date(Date.now() + ms),
            status:     "pending",
          });
          await advanceProgress(progressId, null, "active");
        } else if (nextId) {
          // Zero delay — continue immediately
          await this.runNode(funnelId, nextId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
        }
        return;
      }

      case "condition": {
        const varName  = c.variable_name as string | undefined;
        const operator = c.operator as string | undefined;
        const expected = c.value as string | undefined;
        const actual   = varName ? (vars.get(varName) ?? "") : "";

        let branch = "false";
        if (operator === "equals")       branch = actual === expected ? "true" : "false";
        else if (operator === "contains") branch = actual.includes(expected ?? "") ? "true" : "false";
        else if (operator === "not_empty") branch = actual.length > 0 ? "true" : "false";

        const nextId = await nextNode(funnelId, node.id, branch);
        if (nextId) {
          await this.runNode(funnelId, nextId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
        }
        return;
      }

      case "random": {
        const connections = await db.select().from(nodeConnections)
          .where(and(eq(nodeConnections.funnelId, funnelId), eq(nodeConnections.sourceNodeId, node.id)));
        if (connections.length === 0) return;

        // Frontend salva `content.outputs` = [{ name, weight, handle }], onde handle
        // é "out_0", "out_1", ... e os weights somam ~100. Escolha PONDERADA pelos
        // weights; fallback p/ escolha uniforme entre as conexões quando não houver
        // outputs/weights válidos.
        const outputs = (c.outputs as Array<{ weight?: number; handle?: string }>) ?? [];
        const valid   = outputs.filter((o) => typeof o.handle === "string" && (o.weight ?? 0) > 0);
        const total   = valid.reduce((sum, o) => sum + (o.weight ?? 0), 0);

        let targetId: string | null = null;
        if (valid.length > 0 && total > 0) {
          let r = Math.random() * total;
          let chosenHandle = valid[valid.length - 1].handle!; // fallback p/ último
          for (const o of valid) {
            r -= o.weight ?? 0;
            if (r < 0) { chosenHandle = o.handle!; break; }
          }
          targetId = connections.find((cn) => cn.sourceHandle === chosenHandle)?.targetNodeId
                  ?? await nextNode(funnelId, node.id, chosenHandle);
        }

        // Fallback uniforme se a ponderação não resolveu um alvo conectado.
        if (!targetId) {
          targetId = connections[Math.floor(Math.random() * connections.length)].targetNodeId;
        }

        await this.runNode(funnelId, targetId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
        return;
      }

      case "offer":
        // Offer node sends a message and waits for payment — no automation advance here
        await this.executeOfferNode(c, chatId, tg, protect, vars, node.id);
        await saveOutbound(leadId, botId, { ...c, kind: "offer", nodeId: node.id });
        await advanceProgress(progressId, node.id, "active");
        // Se o lead nunca clicar em comprar, dispara o ramo __pending após o
        // timeout de "sem ação". Cancelado quando ele clica (handleOfferPurchase).
        await this.scheduleOfferTimeouts(funnelId, node, progressId, leadId, botId, "no_action");
        return;
    }

    // Advance to next node automatically for non-blocking nodes
    const nextId = await nextNode(funnelId, node.id);
    if (nextId) {
      await this.runNode(funnelId, nextId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
    } else {
      await advanceProgress(progressId, null, "completed");
    }
  }

  private async executeMessageNode(
    c:       Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
    nodeId:  string,
  ): Promise<void> {
    // O frontend salva o texto em `message` (tanto no nó simples quanto em cada
    // bloco); mantemos fallback p/ `content`/`text` de versões antigas.
    const blocks = (c.blocks as Array<Record<string, unknown>>) ?? [];

    if (blocks.length > 0) {
      // Blocos de BOTÕES (rodapé): o teclado inline é montado uma vez e vai
      // ANEXADO à última mensagem de texto do nó (é assim que o editor mostra:
      // os botões embaixo da mensagem). Sem nenhum bloco de texto, sai numa
      // mensagem própria depois dos demais blocos. Antes o bloco `buttons`
      // simplesmente não era tratado — nenhum teclado era enviado.
      const keyboard = blockButtonsKeyboard(c, vars, nodeId);
      // Índice do último bloco que sai por sendMessage (é onde o teclado gruda).
      const isTextSend = (b: Record<string, unknown>): boolean => {
        const t = (b.message ?? b.content ?? b.text) as string | undefined;
        if (typeof t !== "string" || !t) return false;
        if (b.type === "text") return true;
        const hasUrl = typeof b.url === "string" && b.url;
        const isMedia = b.type === "media" || b.type === "image" || b.type === "video"
                     || b.type === "document" || b.type === "audio";
        return !(isMedia && hasUrl); // cai no fallback textual
      };
      let lastTextIdx = -1;
      if (keyboard.length > 0) {
        blocks.forEach((b, i) => { if (b.type !== "buttons" && isTextSend(b)) lastTextIdx = i; });
      }

      for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
        const block = blocks[blockIdx];
        if (block.type === "buttons") continue; // já virou teclado inline
        const attach = keyboard.length > 0 && blockIdx === lastTextIdx
          ? { inline_keyboard: keyboard }
          : undefined;
        const url       = block.url as string | undefined;
        const text      = (block.message ?? block.content ?? block.text) as string | undefined;
        const caption   = typeof block.caption === "string" ? escapeHtml(interpolate(block.caption, vars)) : undefined;
        const mediaType = (block.media_type ?? block.type) as string | undefined;

        // "digitando…"/"gravando áudio…" ANTES do envio, com pausa proporcional
        // (sem pausa o indicador some no mesmo instante — parecia não funcionar).
        await simulateAction(tg, chatId, !!block.simulate_typing, !!block.simulate_recording, text);

        if (block.type === "text" && text) {
          await tg.sendMessage({ chatId, text: escapeHtml(interpolate(text, vars)), protectContent: protect, replyMarkup: attach });
        } else if ((block.type === "media" || block.type === "image" || block.type === "video" || block.type === "document") && url) {
          if (mediaType === "video")         await tg.sendVideo(chatId, url, caption, protect);
          else if (mediaType === "document") await tg.sendDocument(chatId, url, caption, protect);
          else                               await tg.sendPhoto({ chatId, photo: url, caption, protectContent: protect });
        } else if (block.type === "audio" && url) {
          await tg.sendAudio(chatId, url, caption, protect);
        } else if (text) {
          await tg.sendMessage({ chatId, text: escapeHtml(interpolate(text, vars)), protectContent: protect, replyMarkup: attach });
        }
      }

      // Nenhum bloco de texto para carregar o teclado → mensagem própria.
      if (keyboard.length > 0 && lastTextIdx === -1) {
        const rawTail = (c.message ?? c.text) as string | undefined;
        const tail = typeof rawTail === "string" && rawTail
          ? escapeHtml(interpolate(rawTail, vars))
          : "Escolha uma opção:";
        await tg.sendMessage({ chatId, text: tail, protectContent: protect, replyMarkup: { inline_keyboard: keyboard } });
      }
    } else {
      const text = (c.message ?? c.text) as string | undefined;
      if (typeof text === "string" && text) {
        // Nó de Texto simples (sem blocks): a flag fica em content.simulate_typing.
        await simulateAction(tg, chatId, !!c.simulate_typing, !!c.simulate_recording, text);
        await tg.sendMessage({ chatId, text: escapeHtml(interpolate(text, vars)), protectContent: protect });
      }
    }
  }

  private async executeMediaNode(
    c:       Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
  ): Promise<void> {
    // Nó de mídia: { url, media_type, caption, extra_items[] }. Com 2+ itens de
    // imagem/vídeo, envia como ÁLBUM (sendMediaGroup) — o Telegram agrupa numa só
    // mensagem. Documentos/áudios não entram em álbum e vão individualmente.
    // O caption (HTML) vai só no 1º item do álbum (limite do Telegram).
    const main   = { url: c.url, media_type: c.media_type, caption: c.caption } as Record<string, unknown>;
    const extras = (c.extra_items as Array<Record<string, unknown>>) ?? [];
    const items  = [main, ...extras].filter((it) => typeof it.url === "string" && it.url);

    const capOf  = (it: Record<string, unknown>): string | undefined =>
      typeof it.caption === "string" ? escapeHtml(interpolate(it.caption, vars)) : undefined;
    const typeOf = (it: Record<string, unknown>): string => (it.media_type as string) || "image";
    const isAlbumType = (t: string): boolean => t === "image" || t === "photo" || t === "video";

    const single = (it: Record<string, unknown>): Promise<void> => {
      const url = it.url as string;
      const caption = capOf(it);
      const t = typeOf(it);
      if (t === "video")    return tg.sendVideo(chatId, url, caption, protect);
      if (t === "document") return tg.sendDocument(chatId, url, caption, protect);
      if (t === "audio")    return tg.sendAudio(chatId, url, caption, protect);
      return tg.sendPhoto({ chatId, photo: url, caption, protectContent: protect });
    };

    const albumItems = items.filter((it) => isAlbumType(typeOf(it)));
    if (albumItems.length >= 2) {
      try {
        await tg.sendMediaGroup(
          chatId,
          albumItems.map((it, i) => ({
            type:    typeOf(it) === "video" ? "video" as const : "photo" as const,
            media:   it.url as string,
            caption: i === 0 ? capOf(it) : undefined,
          })),
          protect,
        );
      } catch {
        for (const it of albumItems) await single(it);
      }
      for (const it of items) if (!isAlbumType(typeOf(it))) await single(it);
      return;
    }

    for (const it of items) await single(it);
  }

  private async executeButtonsNode(
    c:       Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
    nodeId:  string,
  ): Promise<void> {
    // Frontend salva o texto em `message` e os botões como { text, callback, action };
    // fallback p/ `text`/`label`/`value` antigos.
    const raw     = (c.message ?? c.text) as string | undefined;
    const text    = typeof raw === "string" && raw ? escapeHtml(interpolate(raw, vars)) : "Escolha uma opção:";
    const buttons = (c.buttons as Array<Record<string, unknown>>) ?? [];
    const keyboard = buttons.map((b, i) => {
      const label = (b.text ?? b.label ?? "") as string;
      const style = telegramButtonStyle(b.style);
      if (typeof b.url === "string" && b.url) return [{ text: label, url: b.url, ...(style ? { style } : {}) }];
      // callback_data = id posicional curto (`btn:<i>`), resolvido no retorno para
      // o handleId do editor (`callback || text || btn_<i>`). Com `callback`
      // preenchido o destino é exatamente o de antes; sem ele, o botão deixa de
      // mandar string vazia (que o Telegram rejeita) e passa a casar com a aresta.
      return [{ text: label, callback_data: buttonCallbackId(nodeId, null, i), ...(style ? { style } : {}) }];
    });
    await tg.sendMessage({
      chatId,
      text,
      protectContent: protect,
      replyMarkup: { inline_keyboard: keyboard },
    });
  }

  private async executeOfferNode(
    c:       Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
    nodeId:  string,
  ): Promise<void> {
    const offersList = collectNodeOffers(c);
    if (offersList.length === 0) return;
    await this.presentOffers(c, offersList, chatId, tg, protect, vars, nodeId);
  }

  // Renderiza um botão de compra por oferta (callback `o:<nó>:<i>`, na ordem de
  // collectNodeOffers). Texto/imagem vêm de intro_message + 1ª oferta.
  private async presentOffers(
    content:    Record<string, unknown>,
    offersList: Array<{ offer: Record<string, unknown>; handleId: string }>,
    chatId:     string,
    tg:         TelegramClient,
    protect:    boolean,
    vars:       Map<string, string>,
    nodeId:     string,
  ): Promise<void> {
    const keyboard = offersList.map(({ offer }, i) => {
      // price vem do nó do funil em REAIS (MoneyInput no front emite reais).
      const price = typeof offer.price === "number" ? offer.price : 0;
      const label = (typeof offer.button_text === "string" && offer.button_text)
        ? offer.button_text
        : `Comprar — R$ ${price.toFixed(2)}`;
      const style = telegramButtonStyle(offer.style);
      return [{ text: label, callback_data: offerCallbackId(nodeId, i), ...(style ? { style } : {}) }];
    });

    const intro = typeof content.intro_message === "string" && content.intro_message
      ? escapeHtml(interpolate(content.intro_message, vars))
      : null;
    const first = offersList[0].offer;
    const firstName = typeof first.product_name === "string" ? first.product_name : "";
    const caption = intro ?? (firstName ? escapeHtml(interpolate(firstName, vars)) : "Escolha uma oferta:");
    const image = typeof first.image_url === "string" ? first.image_url : "";

    if (image) {
      await tg.sendPhoto({ chatId, photo: image, caption, protectContent: protect, replyMarkup: { inline_keyboard: keyboard } });
    } else {
      await tg.sendMessage({ chatId, text: caption, protectContent: protect, replyMarkup: { inline_keyboard: keyboard } });
    }
  }

  // ── Agenda timeouts de oferta (__no_action ao apresentar, __pending após PIX) ─
  // "Sem ação" (nunca clicou) e "Não pago" (clicou, gerou PIX, não pagou) saem
  // pelo MESMO handle __pending — a UI só expõe uma linha/conexão por oferta
  // (ver OfferNode.tsx). O que difere entre os dois casos é só a DURAÇÃO do
  // timeout: `kind` escolhe entre `no_action_timeout` (com fallback pra
  // `unpaid_timeout`) e `unpaid_timeout` puro. Antes disso, eram dois handles
  // separados (__no_action/__pending) — dava pra configurar destinos
  // diferentes, mas na prática 100% dos funis publicados usavam o mesmo
  // destino nos dois (ou só configuravam um dos dois), então unificar não
  // muda o roteamento de ninguém, só simplifica o editor.
  // Agenda um delay por oferta cujo handle (`<handleId>__pending`) tenha
  // conexão. `onlyHandleId`: só a oferta que o lead clicou (kind="unpaid").
  private async scheduleOfferTimeouts(
    funnelId:     string,
    node:         typeof funnelNodes.$inferSelect,
    progressId:   string,
    leadId:       string,
    botId:        string,
    kind:         "no_action" | "unpaid",
    onlyHandleId?: string,
  ): Promise<void> {
    const content = node.content as Record<string, unknown> & { unpaid_timeout?: number; no_action_timeout?: number };
    const offersList = collectNodeOffers(content);
    const unpaidMin  = typeof content.unpaid_timeout === "number" && content.unpaid_timeout > 0 ? content.unpaid_timeout : 5;
    const timeoutMin = kind === "no_action" && typeof content.no_action_timeout === "number" && content.no_action_timeout > 0
      ? content.no_action_timeout
      : unpaidMin;
    const executeAt  = new Date(Date.now() + Math.max(60, timeoutMin * 60) * 1000);

    for (const { handleId } of offersList) {
      if (onlyHandleId !== undefined && handleId !== onlyHandleId) continue;
      const target = await nextNode(funnelId, node.id, `${handleId}__pending`);
      if (!target) continue;
      await db.insert(scheduledDelays).values({
        botId, leadId, funnelId, progressId, nextNodeId: target, executeAt, status: "pending",
      });
    }
  }

  // ── Agenda o timeout "sem clique" de um nó com botões ────────────────────────
  // Espelha o `no_response` do wait_response: só agenda quando o usuário
  // configurou um tempo (`no_click_timeout_seconds` > 0) E ligou o handle
  // `no_click` a um próximo nó. Faltando qualquer um dos dois, NÃO agenda nada —
  // o nó espera indefinidamente, exatamente como antes. Cancelado quando o lead
  // clica (handler de callback / handleOfferPurchase).
  //
  // Semântica combinada com o editor: a saída "Sem clique" SÓ existe com tempo > 0.
  // Aresta desenhada sem tempo é inerte (nada de default inventado, que moveria
  // leads em funis já publicados) e o editor avisa — `useNodeWarnings`.
  private async scheduleNoClickTimeout(
    funnelId:   string,
    node:       typeof funnelNodes.$inferSelect,
    progressId: string,
    leadId:     string,
    botId:      string,
  ): Promise<void> {
    const seconds = noClickTimeoutSeconds(node.content as Record<string, unknown>);
    if (seconds <= 0) return;
    const target = await nextNode(funnelId, node.id, "no_click");
    if (!target) return;
    await db.insert(scheduledDelays).values({
      botId, leadId, funnelId, progressId,
      nextNodeId: target,
      executeAt:  new Date(Date.now() + seconds * 1000),
      status:     "pending",
    });
  }

  // ── Compra: gera PIX, persiste a cobrança e envia copia-e-cola + QR ──────────
  private async handleOfferPurchase(
    offer:  Record<string, unknown>,
    handleId: string,
    node:   typeof funnelNodes.$inferSelect,
    prog:   typeof leadProgress.$inferSelect,
    lead:   typeof leads.$inferSelect,
    bot:    typeof bots.$inferSelect,
    chatId: string,
    tg:     TelegramClient,
  ): Promise<void> {
    // O lead interagiu com a oferta → cancela o timeout de "sem ação" pendente
    // deste progresso (só há os do nó de oferta atual).
    await db.delete(scheduledDelays).where(and(
      eq(scheduledDelays.progressId, prog.id),
      eq(scheduledDelays.status, "pending"),
    ));

    // offer.price está em REAIS no nó do funil; gateway e tabela payments usam centavos.
    const amount    = typeof offer.price === "number" ? Math.round(offer.price * 100) : 0;
    const productName = (typeof offer.product_name === "string" && offer.product_name) ? offer.product_name : "Produto";

    if (amount <= 0) {
      await tg.sendMessage({ chatId, text: "Oferta indisponível no momento.", protectContent: bot.protectContent });
      return;
    }

    // A oferta não escolhe mais gateway: usa a ordem de fallback configurada no bot.
    const chain = await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id });

    let result;
    try {
      result = await createPixWithFallback(chain, {
        amountCents: amount,
        description: productName,
        webhookUrl:  (provider) => `${encoreExternalUrl()}/payments/webhook/${provider}`,
        ownerUserId: bot.userId,
      });
    } catch (err) {
      console.error("[runner] createPix falhou em toda a cadeia:", err);
      await tg.sendMessage({ chatId, text: "Não consegui gerar o PIX agora. Tente novamente em instantes.", protectContent: bot.protectContent });
      return;
    }
    if (!result) {
      await tg.sendMessage({ chatId, text: "Gateway de pagamento não configurado.", protectContent: bot.protectContent });
      return;
    }
    const { gateway: gw, pix } = result;

    // Persiste a cobrança com o contexto p/ retomar o funil quando pago.
    await payRepo.create({
      userId:      bot.userId,
      botId:       bot.id,
      leadId:      lead.id,
      gatewayId:   gw.id,
      offerName:   productName,
      amount,
      status:      "pending",
      saleType:    saleTypeFromNodeContent(node.content as Record<string, unknown> | null),
      externalId:  pix.externalId,
      pixCode:     pix.pixCode,
      description: productName,
      funnelId:    prog.funnelId,
      progressId:  prog.id,
      nodeId:      node.id,
      paidHandle:  `${handleId}__paid`,
    });

    // Gerou PIX e não pagou → dispara o ramo __pending após o unpaid_timeout.
    // Cancelado quando o pagamento confirma (handlePaidOffer).
    await this.scheduleOfferTimeouts(prog.funnelId, node, prog.id, lead.id, bot.id, "unpaid", handleId);

    const caption = `💠 <b>${escapeHtml(productName)}</b>\nValor: R$ ${(amount / 100).toFixed(2)}\n\nPague com o PIX copia-e-cola abaixo 👇`;
    await tg.sendPhoto({ chatId, photo: pix.qrImage, caption, protectContent: bot.protectContent });
    await tg.sendMessage({
      chatId,
      text: `<code>${escapeHtml(pix.pixCode)}</code>`,
      protectContent: bot.protectContent,
      replyMarkup: pixCopyButtonMarkup(pix.pixCode),
    });
    await saveOutbound(lead.id, bot.id, { kind: "offer_pix", offerName: productName, externalId: pix.externalId, nodeId: node.id });
  }

  // ── Compra avulsa de oferta (botão de broadcast/remarketing) → gera PIX ──────
  private async handleBroadcastBuy(
    offerId: string,
    lead: typeof leads.$inferSelect,
    bot:  typeof bots.$inferSelect,
    chatId: string,
    tg:   TelegramClient,
  ): Promise<void> {
    const [offer] = await db.select().from(funnelOffers)
      .where(and(eq(funnelOffers.id, offerId), eq(funnelOffers.botId, bot.id)));
    if (!offer) { await tg.sendMessage({ chatId, text: "⚠️ Produto não encontrado.", protectContent: bot.protectContent }); return; }

    const amount = offer.price; // funnel_offers.price já é em centavos
    if (amount <= 0) { await tg.sendMessage({ chatId, text: "Oferta indisponível no momento.", protectContent: bot.protectContent }); return; }

    const chain = await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id });

    let result;
    try {
      result = await createPixWithFallback(chain, {
        amountCents: amount,
        description: offer.name,
        webhookUrl:  (provider) => `${encoreExternalUrl()}/payments/webhook/${provider}`,
        ownerUserId: bot.userId,
      });
    } catch (err) {
      console.error("[runner] bcast_buy createPix falhou em toda a cadeia:", err);
      await tg.sendMessage({ chatId, text: "Não consegui gerar o PIX agora. Tente novamente em instantes.", protectContent: bot.protectContent });
      return;
    }
    if (!result) { await tg.sendMessage({ chatId, text: "⚠️ Gateway de pagamento não configurado.", protectContent: bot.protectContent }); return; }
    const { gateway: gw, pix } = result;

    await payRepo.create({
      userId: bot.userId, botId: bot.id, leadId: lead.id, gatewayId: gw.id,
      offerId: offer.id, offerName: offer.name, amount, status: "pending",
      externalId: pix.externalId, pixCode: pix.pixCode, description: offer.name,
    });

    const caption = `💠 <b>${escapeHtml(offer.name)}</b>\nValor: R$ ${(amount / 100).toFixed(2)}\n\nPague com o PIX copia-e-cola abaixo 👇`;
    await tg.sendPhoto({ chatId, photo: pix.qrImage, caption, protectContent: bot.protectContent });
    await tg.sendMessage({
      chatId,
      text: `<code>${escapeHtml(pix.pixCode)}</code>`,
      protectContent: bot.protectContent,
      replyMarkup: pixCopyButtonMarkup(pix.pixCode),
    });
  }

  // ── Entrega do produto de uma oferta avulsa (funnel_offers) após pagamento ───
  private async deliverFunnelOffer(payment: Payment): Promise<void> {
    if (!payment.offerId || !payment.leadId) return;
    const [offer] = await db.select().from(funnelOffers).where(eq(funnelOffers.id, payment.offerId));
    const [bot]   = await db.select().from(bots).where(eq(bots.id, payment.botId));
    const [lead]  = await db.select().from(leads).where(eq(leads.id, payment.leadId));
    if (!offer || !bot || !lead) return;
    const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatId = lead.telegramChatId.toString();

    if (offer.productType === "vip_group" && offer.telegramGroupId) {
      const [grp] = await db.select().from(botGroups).where(eq(botGroups.id, offer.telegramGroupId));
      if (grp) {
        const expireDate = offer.accessDays > 0 ? Math.floor(Date.now() / 1000) + offer.accessDays * 86400 : undefined;
        try {
          const link = await tg.createChatInviteLink(grp.telegramChatId.toString(), { memberLimit: 1, expireDate });
          await tg.sendMessage({
            chatId,
            text: "✅ Pagamento confirmado! Toque no botão abaixo para entrar no grupo:",
            replyMarkup: urlButtonMarkup("🚀 Entrar no grupo VIP", link),
            protectContent: bot.protectContent,
          });
          return;
        } catch (e) { console.error("[runner] deliverFunnelOffer invite:", e); }
      }
      await tg.sendMessage({ chatId, text: "✅ Pagamento confirmado! Em instantes você recebe o acesso.", protectContent: bot.protectContent });
      return;
    }
    if (offer.productType === "text" && offer.deliveryText) {
      await tg.sendMessage({ chatId, text: `✅ Pagamento confirmado!\n\n${offer.deliveryText}`, protectContent: bot.protectContent });
      return;
    }
    const url = offer.deliveryUrl ?? "";
    await tg.sendMessage({ chatId, text: url ? `✅ Pagamento confirmado! Acesse seu produto: ${url}` : "✅ Pagamento confirmado!", protectContent: bot.protectContent });
  }

  // ── Pago (chamado pela subscription do webhook): entrega + retoma o funil ────
  async handlePaidOffer(payment: Payment): Promise<void> {
    // Compra avulsa (oferta de broadcast/remarketing): sem contexto de funil, mas
    // com offerId → entrega o produto direto e encerra.
    if ((!payment.progressId || !payment.nodeId || !payment.paidHandle || !payment.funnelId) && payment.offerId) {
      await this.deliverFunnelOffer(payment).catch((e) => console.error("[runner] deliverFunnelOffer falhou:", e));
      return;
    }
    if (!payment.progressId || !payment.nodeId || !payment.paidHandle || !payment.funnelId || !payment.leadId) {
      return; // cobrança sem contexto de funil (ex.: teste de gateway) — ignora
    }

    const [prog] = await db.select().from(leadProgress).where(eq(leadProgress.id, payment.progressId));
    const [lead] = await db.select().from(leads).where(eq(leads.id, payment.leadId));
    const [bot]  = await db.select().from(bots).where(eq(bots.id, payment.botId));
    const [node] = await db.select().from(funnelNodes).where(eq(funnelNodes.id, payment.nodeId));
    if (!prog || !lead || !bot || !node) return;

    const tg     = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatId = lead.telegramChatId.toString();
    const vars   = await getVars(lead.id, bot.id);

    // Pagou → cancela o timeout __pending pendente deste progresso.
    await db.delete(scheduledDelays).where(and(
      eq(scheduledDelays.progressId, payment.progressId),
      eq(scheduledDelays.status, "pending"),
    ));

    // Localiza a oferta paga p/ entregar o produto (handle sem o sufixo __paid).
    // collectNodeOffers cobre tanto o nó offer quanto ofertas embutidas em message.
    const handleId = payment.paidHandle.replace(/__paid$/, "");
    const offer    = collectNodeOffers(node.content as Record<string, unknown>)
      .find((x) => x.handleId === handleId)?.offer;
    if (offer) {
      await this.deliverOffer(offer, chatId, tg, bot.protectContent, vars)
        .catch((e) => console.error("[runner] entrega da oferta falhou:", e));
    }

    // Retoma o funil pelo ramo __paid. Sem conexão nesse handle, cai na saída
    // GENÉRICA do nó (source_handle null): é onde muitos usuários ligam o
    // "continuar após pagamento" no editor — antes era uma aresta morta e o
    // funil parava no "Pagamento confirmado". O handle __pending não entra
    // nesse fallback (tem semântica própria de timeout).
    let nextId = await nextNode(payment.funnelId, payment.nodeId, payment.paidHandle);
    if (!nextId) {
      const [defaultConn] = await db.select().from(nodeConnections).where(and(
        eq(nodeConnections.funnelId, payment.funnelId),
        eq(nodeConnections.sourceNodeId, payment.nodeId),
        isNull(nodeConnections.sourceHandle),
      )).limit(1);
      nextId = defaultConn?.targetNodeId ?? null;
    }
    if (nextId) {
      await advanceProgress(prog.id, nextId, "active");
      await this.runNode(payment.funnelId, nextId, prog.id, lead.id, bot.id, chatId, tg, bot.protectContent, vars, null);
    } else {
      await advanceProgress(prog.id, null, "completed");
    }
  }

  // Entrega do produto pago: link de conteúdo ou convite de grupo VIP.
  private async deliverOffer(
    offer:   Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
  ): Promise<void> {
    const type = typeof offer.product_type === "string" ? offer.product_type : "content";

    if (type === "vip_group") {
      const groupId = (typeof offer.telegram_group_id === "string" ? offer.telegram_group_id : "").trim();
      if (!groupId) return;
      const accessDays = typeof offer.access_days === "number" ? offer.access_days : 0;
      const expireDate = accessDays > 0 ? Math.floor(Date.now() / 1000) + accessDays * 86400 : undefined;
      try {
        const link = await tg.createChatInviteLink(groupId, { memberLimit: 1, expireDate });
        await tg.sendMessage({
          chatId,
          text: "✅ Pagamento confirmado! Toque no botão abaixo para entrar no grupo:",
          replyMarkup: urlButtonMarkup("🚀 Entrar no grupo VIP", link),
          protectContent: protect,
        });
      } catch (err) {
        console.error("[runner] createChatInviteLink falhou:", err);
        await tg.sendMessage({ chatId, text: "✅ Pagamento confirmado! Em instantes você recebe o acesso.", protectContent: protect });
      }
      return;
    }

    const url = typeof offer.delivery_url === "string" ? offer.delivery_url : "";
    const text = url
      ? `✅ Pagamento confirmado! Acesse seu produto: ${escapeHtml(interpolate(url, vars))}`
      : "✅ Pagamento confirmado!";
    await tg.sendMessage({ chatId, text, protectContent: protect });
  }
}
