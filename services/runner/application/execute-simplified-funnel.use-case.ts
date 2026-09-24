import { eq, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  bots, leads, funnels, payments, simplifiedScheduledTasks, leadProgress,
} from "../../shared/schema/index.js";
import { TelegramClient, urlButtonMarkup, pixCopyButtonMarkup } from "./telegram.client.js";
import { interpolate, leadFieldsMap } from "./interpolate.js";
import { telegramButtonStyle } from "./telegram-button-style.js";
import { fmtBRL, sendPixMessages } from "./pix-messages.js";
import { buildOrderBumpCard } from "./order-bump.js";
import { decrypt } from "../../shared/crypto.js";
import { encoreExternalUrl } from "../../config/secrets.js";
import { isUniqueViolation } from "../../shared/db-errors.js";
import { GatewayDrizzleRepository } from "../../payments/infrastructure/gateway.drizzle.repository.js";
import { PaymentDrizzleRepository, type SaleType } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { createPixWithFallback } from "../../payments/application/create-pix-with-fallback.js";
import type { SimplifiedPaymentCtx, SimplifiedDeliveryItem, Payment } from "../../payments/domain/payment.entity.js";
import { sendPushToUser, PUSH_EVENT_TYPES } from "../../notifications/application/send-push.use-case.js";
import { registerOrRenewVipMembership, previewVipInviteExpireEpoch } from "./vip-membership.js";

const gwRepo  = new GatewayDrizzleRepository();
const payRepo = new PaymentDrizzleRepository();

// PIX pendente reaproveitável por até esse tempo (Achado 2/3 da auditoria) —
// mesmo default do timeout "não pago" do funil de FLUXO (unpaidTimeoutMinutes
// em execute-flow-step.use-case.ts), pra manter o mesmo comportamento entre os
// dois tipos de funil. Depois disso, um PIX morto no gateway (expirou lá sem o
// webhook de expiração chegar) não é mais reenviado pra sempre.
const PIX_REUSE_MAX_AGE_MS = 5 * 60_000;

// Escapa conteúdo dinâmico (nome do lead, textos livres do painel) antes de
// mandar com parse_mode HTML — sem isso, um `<`/`&` cru (no first_name do
// Telegram do lead, ou digitado pelo dono no painel) quebra o parser da
// Telegram e a mensagem nem chega (Achado 5 da auditoria; mesmo tratamento já
// aplicado no funil de fluxo, ver escapeHtml em execute-flow-step.use-case.ts).
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Quantas tarefas vencidas um tick processa — precisa de teto pro tick
// TERMINAR (mesmo raciocínio do DELAY_BATCH em runner.ts): sem limite, uma
// fila grande faria um tick durar demais, empilhando os próximos.
const TASK_BATCH = 200;

// Subconjunto de simplified_scheduled_tasks devolvido pelo claim atômico —
// só os campos que runDueTask usa (RETURNING explícito na query, sem select *).
interface DueSimplifiedTask {
  id:        string;
  botId:     string;
  leadId:    string;
  funnelId:  string;
  kind:      string;
  refId:     string;
  paymentId: string | null;
}

// ── Helpers (porte fiel do backend antigo Lovable) ──────────────────────────────

// `sale_type` derivado do contexto do PIX do funil simplificado.
// LIMITAÇÃO CONHECIDA: order bump não vira uma linha própria em `payments` — o
// valor do bump é somado ao PIX do plano (um pagamento só). Por isso um plano
// com bump é gravado como "offer" (o item principal) e o card "Order bumps"
// permanece zerado enquanto o simplificado não separar as cobranças.
function saleTypeFromCtx(kind: SimplifiedPaymentCtx["kind"]): SaleType {
  switch (kind) {
    case "upsell":   return "upsell";
    case "downsell": return "downsell";
    default:         return "offer";
  }
}

// Retorna o texto do campo se for uma string não-vazia (após trim), senão undefined.
function nonEmptyStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

// Normaliza lista de mídias (novo formato `media[]` + legado `media_url`/`media_type`).
function readSimpleMediaList(src: Record<string, unknown> | undefined): Array<{ url: string; type: string; has_spoiler?: boolean }> {
  if (!src) return [];
  const media = src.media as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(media) && media.length > 0) {
    return media
      .filter((m) => m && m.url)
      .map((m) => ({ url: String(m.url), type: (m.type as string) || "image", has_spoiler: !!m.has_spoiler }));
  }
  if (src.media_url) return [{ url: String(src.media_url), type: (src.media_type as string) || "image" }];
  return [];
}

function deliveryTypeOf(e: Record<string, unknown>): "content" | "vip_group" | "text" {
  const dt = (e.delivery_type as string) || (e.vip_group_id ? "vip_group" : "content");
  return dt === "vip_group" ? "vip_group" : dt === "text" ? "text" : "content";
}

function toDeliveryItem(e: Record<string, unknown>): SimplifiedDeliveryItem {
  const dt = deliveryTypeOf(e);
  return {
    name:          (e.name as string) || "Produto",
    delivery_type: dt,
    delivery_url:  dt === "content" ? ((e.delivery_url as string) ?? null) : null,
    delivery_text: dt === "text" ? ((e.delivery_text as string) ?? null) : null,
    vip_group_id:  dt === "vip_group" ? ((e.vip_group_id as string) ?? null) : null,
    access_days:   Number(e.access_days || 0),
  };
}

// Envia bloco de mídia(s): 0 = texto; 1 = mídia simples (+spoiler); 2+ = álbum.
// reply_markup não vai em sendMediaGroup → enviado em mensagem subsequente.
async function sendMediaBlock(opts: {
  tg: TelegramClient;
  chatId: string;
  media: Array<{ url: string; type: string; has_spoiler?: boolean }>;
  caption?: string;
  replyMarkup?: unknown;
  protect: boolean;
}): Promise<void> {
  const { tg, chatId, media, replyMarkup, protect } = opts;
  const text = (opts.caption || "").trim();

  if (media.length === 0) {
    if (!text && !replyMarkup) return;
    await tg.sendMessage({ chatId, text: text || " ", replyMarkup, protectContent: protect });
    return;
  }

  if (media.length === 1) {
    const m = media[0];
    try {
      await tg.sendSingleMedia(chatId, {
        type: m.type, url: m.url, caption: text || undefined,
        hasSpoiler: !!m.has_spoiler, replyMarkup, protect,
      });
    } catch {
      await tg.sendMessage({ chatId, text: text || " ", replyMarkup, protectContent: protect });
    }
    return;
  }

  // 2+: álbum (só image/video). Áudios não vão em álbum.
  const album = media.filter((m) => m.type === "image" || m.type === "video");
  if (album.length < 2) {
    for (let i = 0; i < media.length; i++) {
      await sendMediaBlock({ tg, chatId, media: [media[i]], caption: i === 0 ? text : undefined, protect });
    }
    if (replyMarkup) await tg.sendMessage({ chatId, text: " ", replyMarkup, protectContent: protect });
    return;
  }
  try {
    await tg.sendMediaGroup(
      chatId,
      album.map((m, i) => ({
        type: m.type === "video" ? "video" : "photo",
        media: m.url,
        caption: i === 0 && text ? text : undefined,
        has_spoiler: !!m.has_spoiler,
      })),
      protect,
    );
  } catch {
    await tg.sendMessage({ chatId, text: text || " ", replyMarkup, protectContent: protect });
    return;
  }
  if (replyMarkup) await tg.sendMessage({ chatId, text: "👇", replyMarkup, protectContent: protect });
}

// ── Use case ────────────────────────────────────────────────────────────────────

interface SimplifiedCtx {
  bot:               typeof bots.$inferSelect;
  lead:              typeof leads.$inferSelect;
  chatId:            string;
  funnel:            typeof funnels.$inferSelect;
  text:              string | null;
  callbackData:      string | null;
  callbackMessageId: number | null;
  tg:                TelegramClient;
}

export class ExecuteSimplifiedFunnelUseCase {
  // Retorna true se tratou; false se o caller deve seguir o fluxo normal (flow).
  async handle(ctx: SimplifiedCtx): Promise<boolean> {
    const { bot, lead, chatId, funnel, text, callbackData, callbackMessageId, tg } = ctx;
    const leadVars = leadFieldsMap(lead); // {{first_name}}, {{username}}, ... do lead
    const itp = (t: string) => interpolate(t, leadVars);
    const cfg     = (funnel.simplifiedConfig as Record<string, unknown>) || {};
    const plans   = (cfg.plans as Array<Record<string, unknown>>) ?? [];
    const bumps   = (cfg.order_bumps as Array<Record<string, unknown>>) ?? [];
    const upsells = (cfg.upsells as Array<Record<string, unknown>>) ?? [];
    const downs   = (cfg.downsells as Array<Record<string, unknown>>) ?? [];
    const payCfg  = (cfg.payment as Record<string, unknown>) || {};
    const protect = bot.protectContent;

    // Garante uma linha em lead_progress pra este lead: é ali que o pause
    // manual (POST /leads/:id/pause) grava o estado, mas o simplificado é
    // stateless (não navega por nós) e nunca criava essa linha — leads que só
    // falaram com o simplificado ficavam sem onde a pausa "pousar", e
    // pausar/despausar virava no-op (Achado 6 da auditoria). currentNodeId
    // fica null (não há nó); o guard de pausa em execute-flow-step.use-case.ts
    // (linha que checa `prog?.status === "paused_manual"` antes de rotear pra
    // cá) passa a funcionar pra esses leads também a partir da 1ª interação.
    const [existingProgress] = await db.select({ id: leadProgress.id, status: leadProgress.status })
      .from(leadProgress).where(eq(leadProgress.leadId, lead.id));
    if (!existingProgress) {
      // onConflictDoNothing sem target: dois updates concorrentes do MESMO
      // lead (reentrega at-least-once do update do Telegram) podem ler "sem
      // linha" antes de qualquer um inserir. Hoje isso só cria uma linha
      // duplicada inofensiva (lead_progress não tem unique em lead_id ainda);
      // quando o índice único de lead_progress(lead_id) existir (PR do funil
      // de fluxo), o segundo INSERT vai colidir — sem a guarda, a requisição
      // cairia com erro em vez de simplesmente não inserir de novo. Sem target:
      // pega QUALQUER unique/exclusion violation da tabela, então não depende
      // de coordenar o NOME da constraint entre os dois PRs.
      await db.insert(leadProgress).values({ leadId: lead.id, funnelId: funnel.id, status: "active" })
        .onConflictDoNothing();
    } else if (existingProgress.status === "paused_manual") {
      // Pausado manualmente (atendimento humano): não processa nada — nem
      // mensagem, nem callback, nem gera PIX.
      return true;
    }

    const send = (textMsg: string, replyMarkup?: unknown) =>
      tg.sendMessage({ chatId, text: textMsg, replyMarkup, protectContent: protect });

    // Remove o teclado da mensagem clicada (evita PIX duplo).
    const removeKeyboard = async () => {
      if (callbackMessageId) await tg.editMessageReplyMarkup(chatId, callbackMessageId, { inline_keyboard: [] });
    };

    // ── Callback: UPSELL ──
    const upsellPrefix = `simple_upsell_${funnel.id}_`;
    if (callbackData && (callbackData.startsWith(upsellPrefix) || callbackData.startsWith("su_"))) {
      await removeKeyboard();
      const id = callbackData.startsWith("su_") ? callbackData.slice(3) : callbackData.slice(upsellPrefix.length);
      const u = upsells.find((x) => String(x.id) === id);
      if (!u) { await send("⚠️ Oferta não encontrada."); return true; }
      const amount = Number(u.price || 0);
      if (amount <= 0) return true;
      await this.generatePix({
        bot, lead, chatId, tg, payCfg, amount, productName: String(u.name || "Oferta"),
        ctx: { kind: "upsell", funnelId: funnel.id, items: [toDeliveryItem(u)] },
        refKey: `${funnel.id}:upsell:${id}`, retryCallbackData: callbackData,
      });
      return true;
    }

    // ── Callback: DOWNSELL ──
    const downPrefix = `simple_downsell_${funnel.id}_`;
    if (callbackData && (callbackData.startsWith(downPrefix) || callbackData.startsWith("sd_"))) {
      await removeKeyboard();
      const id = callbackData.startsWith("sd_") ? callbackData.slice(3) : callbackData.slice(downPrefix.length);
      const d = downs.find((x) => String(x.id) === id);
      if (!d) { await send("⚠️ Oferta não encontrada."); return true; }
      const amount = Number(d.price || 0);
      if (amount <= 0) return true;
      await this.generatePix({
        bot, lead, chatId, tg, payCfg, amount, productName: String(d.name || "Oferta"),
        ctx: { kind: "downsell", funnelId: funnel.id, items: [toDeliveryItem(d)] },
        refKey: `${funnel.id}:downsell:${id}`, retryCallbackData: callbackData,
      });
      return true;
    }

    // ── Callback: order bump (sim/não/um) ──
    if (callbackData && callbackData.startsWith("sb_yes_")) {
      await removeKeyboard();
      await this.generatePixForPlan(callbackData.slice("sb_yes_".length), true, ctx, plans, bumps, payCfg, downs);
      return true;
    }
    if (callbackData && callbackData.startsWith("sb_no_")) {
      await removeKeyboard();
      await this.generatePixForPlan(callbackData.slice("sb_no_".length), false, ctx, plans, bumps, payCfg, downs);
      return true;
    }
    if (callbackData && callbackData.startsWith("sb_one_")) {
      await removeKeyboard();
      const rest = callbackData.slice("sb_one_".length);
      const sep = rest.lastIndexOf("_");
      if (sep > 0) {
        await this.generatePixForPlan(rest.slice(0, sep), [rest.slice(sep + 1)], ctx, plans, bumps, payCfg, downs);
      }
      return true;
    }

    // ── Callback: clique em PLANO ──
    const planPrefix = `simple_plan_${funnel.id}_`;
    if (callbackData && (callbackData.startsWith(planPrefix) || callbackData.startsWith("sp_"))) {
      await removeKeyboard();
      const planId = callbackData.startsWith("sp_") ? callbackData.slice(3) : callbackData.slice(planPrefix.length);
      const plan = plans.find((p) => String(p.id) === planId);
      if (!plan) { await send("⚠️ Plano não encontrado."); return true; }
      const applicable = bumps.filter((ob) => {
        const att = ob.attached_plan_ids as string[] | undefined;
        return !att?.length || att.includes(planId);
      });
      if (applicable.length === 0) {
        await this.generatePixForPlan(planId, false, ctx, plans, bumps, payCfg, downs);
      } else {
        await this.sendOrderBumpOffer(tg, chatId, planId, applicable, cfg, protect);
      }
      return true;
    }

    // ── Callback: CTA aceitar / recusar ──
    if (callbackData === `sc_accept_${funnel.id}`) {
      await this.sendPlansBlock(tg, chatId, plans, cfg, protect, leadVars);
      return true;
    }
    if (callbackData === `sc_decline_${funnel.id}`) {
      const cta = (cfg.cta as Record<string, unknown>) || {};
      const msg = escapeHtml(itp((String(cta.decline_message || "Tudo bem! Use /start quando quiser ver as ofertas.")).trim()));
      if (msg) await send(msg);
      return true;
    }

    // Outros callbacks não são do simplificado → deixa o caller decidir.
    if (callbackData) return false;

    // ── Mensagem de texto que não é /start ──
    const isStart = !text || text === "/start" || text.startsWith("/start ");
    if (!isStart) { await send("Use /start para ver os planos disponíveis."); return true; }

    // ── /start: welcome (+ planos se sem CTA) e, se habilitado, o CTA ──
    const welcome = (cfg.welcome as Record<string, unknown>) || {};
    const cta     = (cfg.cta as Record<string, unknown>) || {};
    const ctaEnabled = !!cta.enabled && !!String(cta.text || "").trim();
    const welcomeText = escapeHtml(itp(String(welcome.text || (ctaEnabled ? "" : "Bem-vindo! Escolha um plano abaixo:")).trim()));

    const welcomeKeyboard: Array<Array<Record<string, unknown>>> = [];
    if (!ctaEnabled) {
      for (const plan of plans) {
        if (!plan?.id || !plan?.name) continue;
        const style = telegramButtonStyle(plan.style);
        welcomeKeyboard.push([{ text: `${plan.name} — ${fmtBRL(Number(plan.price || 0))}`, callback_data: `sp_${plan.id}`, ...(style ? { style } : {}) }]);
      }
    }
    for (const btn of (welcome.buttons as Array<Record<string, unknown>>) || []) {
      if (btn?.label && btn?.url) {
        const style = telegramButtonStyle(btn.style);
        welcomeKeyboard.push([{ text: String(btn.label), url: String(btn.url), ...(style ? { style } : {}) }]);
      }
    }
    const welcomeMarkup = welcomeKeyboard.length ? { inline_keyboard: welcomeKeyboard } : undefined;
    const welcomeMedia = readSimpleMediaList(welcome);
    if (welcomeText || welcomeMedia.length > 0) {
      await sendMediaBlock({ tg, chatId, media: welcomeMedia, caption: welcomeText, replyMarkup: welcomeMarkup, protect });
    }

    if (ctaEnabled) {
      const acceptStyle = telegramButtonStyle(cta.accept_style);
      const declineEnabled = cta.decline_enabled !== false;
      const ctaRow: Array<Record<string, unknown>> = [
        { text: String(cta.accept_label || "Quero ver os planos"), callback_data: `sc_accept_${funnel.id}`, ...(acceptStyle ? { style: acceptStyle } : {}) },
      ];
      if (declineEnabled) {
        const declineStyle = telegramButtonStyle(cta.decline_style);
        ctaRow.push({ text: String(cta.decline_label || "Agora não"), callback_data: `sc_decline_${funnel.id}`, ...(declineStyle ? { style: declineStyle } : {}) });
      }
      const ctaKeyboard = [ctaRow];
      await sendMediaBlock({
        tg, chatId, media: readSimpleMediaList(cta), caption: escapeHtml(itp(String(cta.text || "").trim())),
        replyMarkup: { inline_keyboard: ctaKeyboard }, protect,
      });
    }
    return true;
  }

  // ── Bloco de planos ──
  private async sendPlansBlock(tg: TelegramClient, chatId: string, plans: Array<Record<string, unknown>>, cfg: Record<string, unknown>, protect: boolean, leadVars: Map<string, string>): Promise<void> {
    const cta = (cfg.cta as Record<string, unknown>) || {};
    const intro = String(cfg.plans_intro_text ?? cta.plans_intro_text ?? "").trim();
    const keyboard: Array<Array<Record<string, unknown>>> = [];
    for (const plan of plans) {
      if (!plan?.id || !plan?.name) continue;
      const style = telegramButtonStyle(plan.style);
      keyboard.push([{ text: `${plan.name} — ${fmtBRL(Number(plan.price || 0))}`, callback_data: `sp_${plan.id}`, ...(style ? { style } : {}) }]);
    }
    if (!keyboard.length) { await tg.sendMessage({ chatId, text: "⚠️ Nenhum plano configurado.", protectContent: protect }); return; }
    const legacyDescr = plans.map((p) => (typeof p?.description === "string" ? p.description.trim() : "")).filter(Boolean);
    const text = escapeHtml(interpolate(intro || legacyDescr.join("\n\n") || "Planos disponíveis:", leadVars));
    await tg.sendMessage({ chatId, text, replyMarkup: { inline_keyboard: keyboard }, protectContent: protect });
  }

  // ── Card de order bumps ──
  private async sendOrderBumpOffer(tg: TelegramClient, chatId: string, planId: string, applicable: Array<Record<string, unknown>>, cfg: Record<string, unknown>, protect: boolean): Promise<void> {
    const card = buildOrderBumpCard({
      items: applicable.map((ob) => ({
        id: String(ob.id || "").substring(0, 8),
        name: String(ob.name || ""),
        price: Number(ob.price || 0),
        buttonLabel: nonEmptyStr(ob.button_label),
        style: ob.style,
      })),
      introText: escapeHtml(String(cfg.order_bumps_intro_text || "")),
      skipText: nonEmptyStr(cfg.order_bumps_decline_label),
      skipStyle: cfg.order_bumps_decline_style,
      addOneTemplate: nonEmptyStr(cfg.order_bumps_add_one_label),
      addOneStyle: cfg.order_bumps_add_one_style,
      addAllTemplate: nonEmptyStr(cfg.order_bumps_add_all_label),
      addAllStyle: cfg.order_bumps_add_all_style,
      callbackYes: `sb_yes_${planId}`,
      callbackNo: `sb_no_${planId}`,
      callbackOne: (id) => `sb_one_${planId}_${id}`,
    });
    await tg.sendMessage({ chatId, text: card.text, replyMarkup: card.replyMarkup, protectContent: protect });
  }

  // ── Gera PIX de um plano (com/sem bumps) + agenda downsells ──
  // bumpsSelection: true = todos aplicáveis, false = nenhum, string[] = short ids específicos
  private async generatePixForPlan(
    planId: string,
    bumpsSelection: boolean | string[],
    ctx: SimplifiedCtx,
    plans: Array<Record<string, unknown>>,
    bumps: Array<Record<string, unknown>>,
    payCfg: Record<string, unknown>,
    downs: Array<Record<string, unknown>>,
  ): Promise<void> {
    const { bot, lead, chatId, tg, funnel } = ctx;
    const plan = plans.find((p) => String(p.id) === planId);
    if (!plan) { await tg.sendMessage({ chatId, text: "⚠️ Plano não encontrado.", protectContent: bot.protectContent }); return; }

    const allApplicable = bumps.filter((ob) => {
      const att = ob.attached_plan_ids as string[] | undefined;
      return !att?.length || att.includes(planId);
    });
    let selected: Array<Record<string, unknown>> = [];
    if (bumpsSelection === true) selected = allApplicable;
    else if (Array.isArray(bumpsSelection)) {
      const set = new Set(bumpsSelection);
      selected = allApplicable.filter((ob) => set.has(String(ob.id || "").substring(0, 8)));
    }
    const bumpsTotal  = selected.reduce((s, ob) => s + Number(ob.price || 0), 0);
    const totalAmount = Number(plan.price || 0) + bumpsTotal;
    if (totalAmount <= 0) { await tg.sendMessage({ chatId, text: "⚠️ Valor inválido.", protectContent: bot.protectContent }); return; }

    const bumpsSig = selected.length
      ? selected.map((ob) => String(ob.id || "").substring(0, 8)).sort().join("-")
      : "";
    const refKey = bumpsSig ? `${funnel.id}:plan:${planId}:bumps:${bumpsSig}` : `${funnel.id}:plan:${planId}`;
    const items = [toDeliveryItem(plan), ...selected.map(toDeliveryItem)];

    const { paymentId } = await this.generatePix({
      bot, lead, chatId, tg, payCfg, amount: totalAmount, productName: String(plan.name || "Plano"),
      ctx: { kind: "plan", funnelId: funnel.id, planId, items },
      refKey, retryCallbackData: ctx.callbackData,
    });

    // Agenda downsells (uma vez) p/ esse PIX.
    if (paymentId) {
      await this.scheduleDownsells(bot.id, lead.id, funnel.id, planId, paymentId, downs)
        .catch((e) => console.error("[simplified] scheduleDownsells:", e));
    }
  }

  // ── Geração de PIX (persistência + envio) ──
  private async generatePix(opts: {
    bot: typeof bots.$inferSelect;
    lead: typeof leads.$inferSelect;
    chatId: string;
    tg: TelegramClient;
    payCfg: Record<string, unknown>;
    amount: number;
    productName: string;
    ctx: SimplifiedPaymentCtx;
    refKey: string;
    // Callback que reproduz ESTE MESMO clique (plano/upsell/downsell/bump) — se
    // a geração falhar, vira um botão "tentar de novo" na mensagem de erro em
    // vez de deixar o lead sem nenhuma saída (Achado 4 da auditoria).
    retryCallbackData?: string | null;
  }): Promise<{ paymentId: string | null }> {
    const { bot, lead, chatId, tg, payCfg, amount, productName, ctx, refKey, retryCallbackData } = opts;
    // amount chega em REAIS (preços do funil simplificado); gateway e tabela
    // payments trabalham em centavos. Display (fmtBRL) continua em reais.
    const amountCents = Math.round(amount * 100);
    const retryMarkup = retryCallbackData
      ? { inline_keyboard: [[{ text: "🔄 Tentar novamente", callback_data: retryCallbackData }]] }
      : undefined;

    // Dedupe (Achado 2/3): reaproveita um PIX pendente pra este MESMO refKey —
    // refKey já embute oferta+bumps (ver generatePixForPlan/upsell/downsell
    // acima), então uma seleção de bump diferente NUNCA reusa o PIX de outra
    // combinação; a checagem de amountCents cobre o caso raro do dono editar o
    // preço entre um clique e outro. Teto de idade: PIX morto no gateway (sem
    // o webhook de expiração ter chegado) não é reenviado pra sempre.
    const existing = await payRepo.findPendingByOfferRef(lead.id, refKey);
    if (existing?.pixCode) {
      const ageMs = Date.now() - existing.createdAt.getTime();
      if (existing.amount === amountCents && ageMs < PIX_REUSE_MAX_AGE_MS) {
        await this.resendPix(chatId, bot, tg, existing.pixCode);
        return { paymentId: existing.id };
      }
      // Valor mudou (config editada) ou passou do teto: expira p/ liberar a
      // constraint única (payments_pending_offer_ref_unique) antes do INSERT.
      // Transição condicional (só sai de "pending"): o webhook pode confirmar
      // o pagamento ENTRE o findPendingByOfferRef acima e esta linha — um
      // updateStatus incondicional rebaixaria essa venda PAGA pra "expired".
      // Mesmo padrão de handleOfferPurchase no funil de fluxo.
      const expired = await payRepo.transitionStatus(existing.id, "expired");
      if (!expired) {
        const current = await payRepo.findById(existing.id);
        // Virou paga na corrida: a entrega já vem pelo paymentPaid (webhook) —
        // não gera outro PIX (cobraria de novo) nem agenda downsell por cima.
        if (current?.status === "paid") return { paymentId: null };
      }
    }

    // O funil não escolhe mais gateway: usa a ordem de fallback configurada no bot.
    const chain = await gwRepo.findChainForBot({ userId: bot.userId, botId: bot.id });

    let result;
    try {
      result = await createPixWithFallback(chain, {
        amountCents,
        description: productName,
        webhookUrl:  (provider) => `${encoreExternalUrl()}/payments/webhook/${provider}`,
        ownerUserId: bot.userId,
      });
    } catch (err) {
      console.error("[simplified] createPix falhou em toda a cadeia:", err);
      await tg.sendMessage({
        chatId, text: "⚠️ Não consegui gerar o PIX agora. Toque no botão abaixo pra tentar de novo.",
        replyMarkup: retryMarkup, protectContent: bot.protectContent,
      });
      return { paymentId: null };
    }
    if (!result) {
      await tg.sendMessage({
        chatId, text: "⚠️ Pagamento indisponível no momento. Toque no botão abaixo pra tentar de novo em instantes.",
        replyMarkup: retryMarkup, protectContent: bot.protectContent,
      });
      return { paymentId: null };
    }
    const { gateway: gw, pix } = result;

    let created: Payment;
    try {
      created = await payRepo.create({
        userId:           bot.userId,
        botId:            bot.id,
        leadId:           lead.id,
        gatewayId:        gw.id,
        offerName:        productName,
        offerExternalRef: refKey,
        amount:           amountCents,
        status:           "pending",
        saleType:         saleTypeFromCtx(ctx.kind),
        externalId:       pix.externalId,
        pixCode:          pix.pixCode,
        description:      productName,
        funnelId:         ctx.funnelId,
        simplifiedCtx:    ctx,
        splitSnapshot:    result.splitSnapshot,
      });
    } catch (err) {
      // Corrida: entre o findPendingByOfferRef lá em cima e este INSERT, outra
      // execução concorrente (duplo-toque do lead, ou reentrega at-least-once
      // do update do Telegram) já criou o pendente pra este MESMO refKey — a
      // constraint única parcial (payments_pending_offer_ref_unique, migration
      // 0023) barrou a duplicata. O PIX que ESTA execução gerou no gateway fica
      // órfão; reenviamos o da concorrente que ganhou a corrida (mesmo padrão
      // de handleOfferPurchase no funil de fluxo).
      if (isUniqueViolation(err, "payments_pending_offer_ref_unique")) {
        const winner = await payRepo.findPendingByOfferRef(lead.id, refKey);
        if (winner?.pixCode) {
          await this.resendPix(chatId, bot, tg, winner.pixCode);
          return { paymentId: winner.id };
        }
      }
      throw err;
    }

    // Push para o dono do bot. Não bloqueia a entrega do PIX ao lead —
    // sendPushToUser trata os próprios erros, o catch aqui é só cinto extra.
    void sendPushToUser(bot.userId, {
      eventType: PUSH_EVENT_TYPES.PIX_GENERATED,
      title:     "🧾 PIX gerado",
      body:      `${productName} — ${fmtBRL(amount)}`,
      data:      { url: "/sales", lead_id: lead.id },
    }).catch((err) => console.error("[simplified] push de PIX gerado falhou:", err));

    // O "botão nativo de copiar" (bloco <pre><code>, tap-to-copy) foi removido:
    // não funcionava em vários celulares. `pix_native_copy` é ignorado mesmo se
    // vier true de um funil antigo salvo no banco. Mantemos o <code> no texto
    // (clients velhos ainda conseguem selecionar) e o botão inline sempre ativo.
    await sendPixMessages({
      tg, chatId, pixCode: pix.pixCode,
      qrPhoto: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=15&data=${encodeURIComponent(pix.pixCode)}`,
      amountReais: amount, productName, payCfg, protect: bot.protectContent,
      leadName: lead.firstName ?? "", fallback: "simplified",
    });
    return { paymentId: created.id };
  }

  // Reenvia o código copia-e-cola de um PIX já pendente (dedupe) — sem repetir
  // QR/legenda, só o essencial pra pagar. Mesmo padrão de resendPix no funil
  // de fluxo (execute-flow-step.use-case.ts).
  private async resendPix(chatId: string, bot: typeof bots.$inferSelect, tg: TelegramClient, pixCode: string): Promise<void> {
    await tg.sendMessage({
      chatId,
      text: `<code>${escapeHtml(pixCode)}</code>`,
      protectContent: bot.protectContent,
      replyMarkup: pixCopyButtonMarkup(pixCode),
    });
  }

  // ── Pago: entrega os itens + agenda upsells (chamado pelo subscriber paymentPaid) ──
  async deliverPaid(payment: Payment): Promise<void> {
    const ctx = payment.simplifiedCtx;
    if (!ctx || !payment.leadId) return;

    const [bot]  = await db.select().from(bots).where(eq(bots.id, payment.botId));
    const [lead] = await db.select().from(leads).where(eq(leads.id, payment.leadId));
    if (!bot || !lead) return;
    const tg     = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatId = lead.telegramChatId.toString();
    const protect = bot.protectContent;

    await tg.sendMessage({ chatId, text: "✅ <b>Pagamento confirmado!</b>\n\nPreparando sua entrega...", protectContent: protect });

    const leadVars = leadFieldsMap(lead);
    for (const item of ctx.items ?? []) {
      await this.deliverItem(tg, chatId, item, lead.id, protect, leadVars, bot.id, lead, payment.id)
        .catch((e) => console.error("[simplified] deliverItem:", e));
    }

    if (ctx.kind === "plan" && ctx.planId) {
      await this.scheduleUpsells(bot.id, lead.id, ctx.funnelId, ctx.planId, payment.id)
        .catch((e) => console.error("[simplified] scheduleUpsells:", e));
    }
  }

  private async deliverItem(
    tg: TelegramClient, chatId: string, item: SimplifiedDeliveryItem, leadId: string, protect: boolean,
    leadVars: Map<string, string> = new Map(),
    botId?: string, lead?: { telegramChatId: bigint; telegramUsername: string | null; firstName: string | null; lastName: string | null }, paymentId?: string,
  ): Promise<void> {
    const name = escapeHtml(interpolate(item.name, leadVars));
    if (item.delivery_type === "content" && item.delivery_url) {
      await tg.sendMessage({ chatId, text: `📦 <b>${name}</b>\n\n🔗 Acesse seu conteúdo:\n${escapeHtml(interpolate(item.delivery_url, leadVars))}`, protectContent: protect });
    } else if (item.delivery_type === "text" && item.delivery_text) {
      await tg.sendMessage({ chatId, text: `📦 <b>${name}</b>\n\n${escapeHtml(interpolate(item.delivery_text, leadVars))}`, protectContent: protect });
    } else if (item.delivery_type === "vip_group" && item.vip_group_id) {
      // botId/lead só faltam quando chamado de fora de deliverPaid (não há
      // outro caller hoje) — sem eles não dá pra consultar o vencimento
      // empilhado, cai no cálculo simples (só os dias desta entrega).
      const expireDate = botId && lead
        ? await previewVipInviteExpireEpoch(botId, item.vip_group_id, lead.telegramChatId, item.access_days)
        : ((item.access_days || 0) > 0 ? Math.floor(Date.now() / 1000) + (item.access_days as number) * 86400 : undefined);
      try {
        const link = await tg.createChatInviteLink(item.vip_group_id, { memberLimit: 1, expireDate });
        await tg.sendMessage({
          chatId,
          text: `🎉 <b>${name}</b>\n\nToque no botão abaixo para entrar no grupo VIP.\n⚠️ O convite é único e só pode ser usado uma vez.`,
          replyMarkup: urlButtonMarkup("🚀 Entrar no grupo VIP", link),
          protectContent: protect,
        });
        // botId/lead/paymentId só faltam quando chamado de fora de deliverPaid
        // (não há outro caller hoje) — checagem defensiva, não bloqueia entrega.
        if (botId && lead) {
          await registerOrRenewVipMembership({
            botId, groupTelegramChatId: item.vip_group_id, memberTelegramChatId: lead.telegramChatId,
            username: lead.telegramUsername, firstName: lead.firstName, lastName: lead.lastName,
            accessDays: item.access_days ?? null, paymentId: paymentId ?? null, offerId: null,
          }).catch((e) => console.error("[simplified] registerOrRenewVipMembership:", e));
        }
      } catch (err) {
        console.error("[simplified] createChatInviteLink:", err);
        await tg.sendMessage({ chatId, text: `📦 <b>${name}</b>\n\n⚠️ Não foi possível gerar o link de convite automaticamente. Entre em contato com o suporte.`, protectContent: protect });
      }
    }
  }

  // ── Agendamento (upsell pós-compra / downsell pós-PIX sem pagamento) ──
  private async scheduleUpsells(botId: string, leadId: string, funnelId: string, planId: string, paymentId: string): Promise<void> {
    const [funnel] = await db.select().from(funnels).where(eq(funnels.id, funnelId));
    if (!funnel || funnel.kind !== "simplified") return;
    const cfg = (funnel.simplifiedConfig as Record<string, unknown>) || {};
    const upsells = (cfg.upsells as Array<Record<string, unknown>>) ?? [];
    const applicable = upsells.filter((u) => {
      const trig = u.trigger_plan_ids as string[] | undefined;
      return !Array.isArray(trig) || trig.length === 0 || trig.includes(planId);
    });
    for (const u of applicable) {
      const delayMin = Math.max(0, Number(u.delay_minutes || 0));
      await db.insert(simplifiedScheduledTasks).values({
        botId, leadId, funnelId, kind: "upsell", refId: String(u.id), paymentId,
        executeAt: new Date(Date.now() + delayMin * 60_000), status: "pending",
      }).onConflictDoNothing();
    }
  }

  private async scheduleDownsells(botId: string, leadId: string, funnelId: string, planId: string, paymentId: string, downs: Array<Record<string, unknown>>): Promise<void> {
    const applicable = downs.filter((d) => {
      const src = d.source_plan_ids as string[] | undefined;
      return !Array.isArray(src) || src.length === 0 || src.includes(planId);
    });
    for (const d of applicable) {
      const delayMin = Math.max(0, Number(d.delay_minutes || 30));
      await db.insert(simplifiedScheduledTasks).values({
        botId, leadId, funnelId, kind: "downsell", refId: String(d.id), paymentId,
        executeAt: new Date(Date.now() + delayMin * 60_000), status: "pending",
      }).onConflictDoNothing();
    }
  }

  // ── Processa tarefas agendadas vencidas (chamado pelo tick de 60s do runner) ──
  async processDueTasks(): Promise<number> {
    // Claim atômico: marca "processing" e devolve as linhas vencidas numa
    // única query. FOR UPDATE SKIP LOCKED → com várias réplicas rodando o
    // tick, cada uma pega um lote DISJUNTO — sem isso, a mesma tarefa vencida
    // (upsell, downsell, lembrete) podia ser pega por duas réplicas e
    // executada em dobro (Achado 1 da auditoria). execute_at = now() no claim
    // marca QUANDO a tarefa foi pega: é o relógio que recoverStuckSimplifiedTasks
    // (runner.ts) usa pra resgatar órfãs — a tabela não tem updated_at, e o
    // execute_at ORIGINAL (o agendamento) já é passado por definição, então
    // usá-lo direto daria falso positivo em tarefa recém-claimed. Mesmo padrão
    // de runDuePendingDelays em runner.ts.
    const claimed = await db.execute(sql`
      UPDATE simplified_scheduled_tasks SET status = 'processing', execute_at = now()
      WHERE id IN (
        SELECT id FROM simplified_scheduled_tasks
        WHERE status = 'pending' AND execute_at <= now()
        ORDER BY execute_at ASC
        LIMIT ${TASK_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, bot_id AS "botId", lead_id AS "leadId", funnel_id AS "funnelId",
                kind, ref_id AS "refId", payment_id AS "paymentId"
    `);
    const due = (claimed.rows ?? []) as unknown as DueSimplifiedTask[];

    let processed = 0;
    for (const task of due) {
      try {
        // Lead pausado manualmente (atendimento humano): não manda upsell nem
        // downsell enquanto durar a pausa (Achado 6 da auditoria).
        if (await this.isLeadPaused(task.leadId)) {
          await db.update(simplifiedScheduledTasks).set({ status: "skipped" }).where(eq(simplifiedScheduledTasks.id, task.id));
          continue;
        }
        await this.runDueTask(task);
        await db.update(simplifiedScheduledTasks).set({ status: "done" }).where(eq(simplifiedScheduledTasks.id, task.id));
        processed++;
      } catch (err) {
        console.error(`[simplified] task ${task.id} falhou:`, err);
        await db.update(simplifiedScheduledTasks).set({ status: "failed" }).where(eq(simplifiedScheduledTasks.id, task.id));
      }
    }
    return processed;
  }

  // Mesma checagem do guard de pausa manual em execute-flow-step.use-case.ts
  // (`prog?.status === "paused_manual"`), só que sem depender de já ter um
  // `prog` carregado — usada pelo tick de tarefas, que só tem o leadId.
  private async isLeadPaused(leadId: string): Promise<boolean> {
    const rows = await db.select({ status: leadProgress.status }).from(leadProgress).where(eq(leadProgress.leadId, leadId));
    return rows.some((r) => r.status === "paused_manual");
  }

  private async runDueTask(task: DueSimplifiedTask): Promise<void> {
    const [bot]    = await db.select().from(bots).where(eq(bots.id, task.botId));
    const [lead]   = await db.select().from(leads).where(eq(leads.id, task.leadId));
    const [funnel] = await db.select().from(funnels).where(eq(funnels.id, task.funnelId));
    if (!bot || !lead || !funnel || funnel.kind !== "simplified") return;

    const cfg = (funnel.simplifiedConfig as Record<string, unknown>) || {};
    const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatId = lead.telegramChatId.toString();

    if (task.kind === "upsell") {
      const upsells = (cfg.upsells as Array<Record<string, unknown>>) ?? [];
      const u = upsells.find((x) => String(x.id) === task.refId);
      if (!u) return;
      const priceLabel = fmtBRL(Number(u.price || 0));
      const text = (typeof u.description === "string" && u.description.trim())
        ? escapeHtml(u.description.trim())
        : `🎁 <b>Oferta especial só pra você!</b>\n\n<b>${escapeHtml(String(u.name || ""))}</b>\n\nAdicione agora por apenas <b>${priceLabel}</b>.`;
      const uStyle = telegramButtonStyle(u.style);
      await tg.sendMessage({
        chatId, text, protectContent: bot.protectContent,
        replyMarkup: { inline_keyboard: [[{ text: `✅ Quero! — ${priceLabel}`, callback_data: `su_${task.refId}`, ...(uStyle ? { style: uStyle } : {}) }]] },
      });
      return;
    }

    if (task.kind === "downsell") {
      // Só envia se o pagamento original continua não pago.
      if (task.paymentId) {
        const [pay] = await db.select().from(payments).where(eq(payments.id, task.paymentId));
        if (pay?.status === "paid") return;
      }
      const downs = (cfg.downsells as Array<Record<string, unknown>>) ?? [];
      const d = downs.find((x) => String(x.id) === task.refId);
      if (!d) return;
      const priceLabel = fmtBRL(Number(d.price || 0));
      const text = (typeof d.description === "string" && d.description.trim())
        ? escapeHtml(d.description.trim())
        : `💡 <b>Última chance!</b>\n\nQue tal levar <b>${escapeHtml(String(d.name || ""))}</b> por apenas <b>${priceLabel}</b>?`;
      const dStyle = telegramButtonStyle(d.style);
      await tg.sendMessage({
        chatId, text, protectContent: bot.protectContent,
        replyMarkup: { inline_keyboard: [[{ text: `✅ Quero! — ${priceLabel}`, callback_data: `sd_${task.refId}`, ...(dStyle ? { style: dStyle } : {}) }]] },
      });
    }
  }
}
