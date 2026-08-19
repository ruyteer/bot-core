import { eq, and, lte } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  bots, leads, funnels, payments, simplifiedScheduledTasks,
} from "../../shared/schema/index.js";
import { TelegramClient, urlButtonMarkup, pixCopyButtonMarkup } from "./telegram.client.js";
import { interpolate, leadFieldsMap } from "./interpolate.js";
import { telegramButtonStyle } from "./telegram-button-style.js";
import { decrypt } from "../../shared/crypto.js";
import { encoreExternalUrl } from "../../config/secrets.js";
import { GatewayDrizzleRepository } from "../../payments/infrastructure/gateway.drizzle.repository.js";
import { PaymentDrizzleRepository, type SaleType } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { createPixWithFallback } from "../../payments/application/create-pix-with-fallback.js";
import type { SimplifiedPaymentCtx, SimplifiedDeliveryItem, Payment } from "../../payments/domain/payment.entity.js";

const gwRepo  = new GatewayDrizzleRepository();
const payRepo = new PaymentDrizzleRepository();

// ── Helpers (porte fiel do backend antigo Lovable) ──────────────────────────────

function fmtBRL(centavos: number): string {
  return Number(centavos || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

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

function replacePixVariables(text: string, vars: { nome?: string; valor?: string; produto?: string; descricao?: string; mensagem?: string }): string {
  if (!text) return text || "";
  return text
    .replace(/\{nome\}/gi, vars.nome || "")
    .replace(/\{valor\}/gi, vars.valor || "")
    .replace(/\{produto\}/gi, vars.produto || "")
    .replace(/\{descricao\}/gi, vars.descricao || "")
    .replace(/\{mensagem\}/gi, vars.mensagem || "");
}

// Placeholders suportados nos labels editáveis de order bump: {nome} e {preco}
// ({valor} é aceito como apelido de {preco}, para bater com os templates de PIX).
function replaceOrderBumpVars(text: string, vars: { nome?: string; preco?: string }): string {
  if (!text) return text || "";
  return text
    .replace(/\{nome\}/gi, vars.nome || "")
    .replace(/\{(preco|valor)\}/gi, vars.preco || "");
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
        refKey: `${funnel.id}:upsell:${id}`,
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
        refKey: `${funnel.id}:downsell:${id}`,
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
      const msg = itp((String(cta.decline_message || "Tudo bem! Use /start quando quiser ver as ofertas.")).trim());
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
    const welcomeText = itp(String(welcome.text || (ctaEnabled ? "" : "Bem-vindo! Escolha um plano abaixo:")).trim());

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
      const declineStyle = telegramButtonStyle(cta.decline_style);
      const ctaKeyboard = [[
        { text: String(cta.accept_label || "Quero ver os planos"), callback_data: `sc_accept_${funnel.id}`, ...(acceptStyle ? { style: acceptStyle } : {}) },
        { text: String(cta.decline_label || "Agora não"), callback_data: `sc_decline_${funnel.id}`, ...(declineStyle ? { style: declineStyle } : {}) },
      ]];
      await sendMediaBlock({
        tg, chatId, media: readSimpleMediaList(cta), caption: itp(String(cta.text || "").trim()),
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
    const text = interpolate(intro || legacyDescr.join("\n\n") || "Planos disponíveis:", leadVars);
    await tg.sendMessage({ chatId, text, replyMarkup: { inline_keyboard: keyboard }, protectContent: protect });
  }

  // ── Card de order bumps ──
  private async sendOrderBumpOffer(tg: TelegramClient, chatId: string, planId: string, applicable: Array<Record<string, unknown>>, cfg: Record<string, unknown>, protect: boolean): Promise<void> {
    const bumpsTotal = applicable.reduce((s, ob) => s + Number(ob.price || 0), 0);
    const text = String(cfg.order_bumps_intro_text || "").trim() || "🎁 Adicione ao seu pedido:";
    const keyboard: Array<Array<Record<string, unknown>>> = [];
    if (applicable.length > 1) {
      for (const ob of applicable) {
        const shortId = String(ob.id || "").substring(0, 8);
        const itemLabelTpl = nonEmptyStr(ob.button_label) || "➕ {nome} (+{preco})";
        const itemLabel = replaceOrderBumpVars(itemLabelTpl, { nome: String(ob.name || ""), preco: fmtBRL(Number(ob.price || 0)) });
        const style = telegramButtonStyle(ob.style);
        keyboard.push([{ text: itemLabel, callback_data: `sb_one_${planId}_${shortId}`, ...(style ? { style } : {}) }]);
      }
      const addAllTpl = nonEmptyStr(cfg.order_bumps_add_all_label) || "✅ Adicionar tudo (+{preco})";
      const addAllStyle = telegramButtonStyle(cfg.order_bumps_add_all_style);
      keyboard.push([{ text: replaceOrderBumpVars(addAllTpl, { preco: fmtBRL(bumpsTotal) }), callback_data: `sb_yes_${planId}`, ...(addAllStyle ? { style: addAllStyle } : {}) }]);
    } else {
      const addOneTpl = nonEmptyStr(cfg.order_bumps_add_one_label) || "✅ Adicionar (+{preco})";
      const addOneStyle = telegramButtonStyle(cfg.order_bumps_add_one_style);
      keyboard.push([{ text: replaceOrderBumpVars(addOneTpl, { nome: String(applicable[0]?.name || ""), preco: fmtBRL(bumpsTotal) }), callback_data: `sb_yes_${planId}`, ...(addOneStyle ? { style: addOneStyle } : {}) }]);
    }
    const declineLabel = nonEmptyStr(cfg.order_bumps_decline_label) || "Não, obrigado";
    const declineStyle = telegramButtonStyle(cfg.order_bumps_decline_style);
    keyboard.push([{ text: declineLabel, callback_data: `sb_no_${planId}`, ...(declineStyle ? { style: declineStyle } : {}) }]);
    await tg.sendMessage({ chatId, text, replyMarkup: { inline_keyboard: keyboard }, protectContent: protect });
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
      refKey,
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
  }): Promise<{ paymentId: string | null }> {
    const { bot, lead, chatId, tg, payCfg, amount, productName, ctx, refKey } = opts;
    // amount chega em REAIS (preços do funil simplificado); gateway e tabela
    // payments trabalham em centavos. Display (fmtBRL) continua em reais.
    const amountCents = Math.round(amount * 100);

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
      await tg.sendMessage({ chatId, text: "⚠️ Erro ao gerar PIX. Tente novamente.", protectContent: bot.protectContent });
      return { paymentId: null };
    }
    if (!result) {
      await tg.sendMessage({ chatId, text: "⚠️ Gateway de pagamento não configurado.", protectContent: bot.protectContent });
      return { paymentId: null };
    }
    const { gateway: gw, pix } = result;

    const created = await payRepo.create({
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
    });

    await this.sendPixMessages(tg, chatId, pix.pixCode, amount, productName, payCfg, bot.protectContent, lead.firstName ?? "");
    return { paymentId: created.id };
  }

  // ── Envio das mensagens do PIX (QR + copia-e-cola), respeitando o payment config ──
  private async sendPixMessages(
    tg: TelegramClient,
    chatId: string,
    pixCode: string,
    amount: number,
    productName: string,
    payCfg: Record<string, unknown>,
    protect: boolean,
    leadName = "",
  ): Promise<void> {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=15&data=${encodeURIComponent(pixCode)}`;
    // {nome} era substituído por "" fixo — o lead nunca via o próprio nome.
    const pixVars = { nome: leadName, valor: fmtBRL(amount), produto: productName, descricao: "", mensagem: "" };

    const qrCaption = payCfg.pix_caption_template
      ? replacePixVariables(String(payCfg.pix_caption_template), pixVars)
      : `🛒 ${productName}\n\n💰 Total: ${fmtBRL(amount)}\n\nEscaneie o QR Code para pagar!`;
    const copyText = payCfg.pix_copy_text
      ? replacePixVariables(String(payCfg.pix_copy_text), pixVars)
      : "👆 Ou copie o código acima e cole no app do seu banco.";

    const sendMode  = payCfg.pix_send_mode === "combined" ? "combined" : "separate";
    // O "botão nativo de copiar" (bloco <pre><code>, tap-to-copy) foi removido:
    // não funcionava em vários celulares. `pix_native_copy` é ignorado mesmo se
    // vier true de um funil antigo salvo no banco. Mantemos o <code> no texto
    // (clients velhos ainda conseguem selecionar) e o botão inline sempre ativo.
    const pixCodeHtml = `<code>${pixCode}</code>`;

    const copyButtonMarkup = pixCopyButtonMarkup(
      pixCode,
      typeof payCfg.pix_copy_button_label === "string" ? payCfg.pix_copy_button_label : undefined,
    );

    if (sendMode === "combined") {
      await tg.sendPhoto({
        chatId, photo: qrUrl, caption: `${qrCaption}\n\n${pixCodeHtml}\n\n${copyText}`,
        protectContent: protect, replyMarkup: copyButtonMarkup,
      });
    } else {
      await tg.sendPhoto({ chatId, photo: qrUrl, caption: qrCaption, protectContent: protect });
      await tg.sendMessage({ chatId, text: `${pixCodeHtml}\n\n${copyText}`, protectContent: protect, replyMarkup: copyButtonMarkup });
    }

    if (payCfg.pix_after_text) {
      await tg.sendMessage({ chatId, text: replacePixVariables(String(payCfg.pix_after_text), pixVars), protectContent: protect });
    }
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
      await this.deliverItem(tg, chatId, item, lead.id, protect, leadVars).catch((e) => console.error("[simplified] deliverItem:", e));
    }

    if (ctx.kind === "plan" && ctx.planId) {
      await this.scheduleUpsells(bot.id, lead.id, ctx.funnelId, ctx.planId, payment.id)
        .catch((e) => console.error("[simplified] scheduleUpsells:", e));
    }
  }

  private async deliverItem(tg: TelegramClient, chatId: string, item: SimplifiedDeliveryItem, leadId: string, protect: boolean, leadVars: Map<string, string> = new Map()): Promise<void> {
    const name = interpolate(item.name, leadVars);
    if (item.delivery_type === "content" && item.delivery_url) {
      await tg.sendMessage({ chatId, text: `📦 <b>${name}</b>\n\n🔗 Acesse seu conteúdo:\n${interpolate(item.delivery_url, leadVars)}`, protectContent: protect });
    } else if (item.delivery_type === "text" && item.delivery_text) {
      await tg.sendMessage({ chatId, text: `📦 <b>${name}</b>\n\n${interpolate(item.delivery_text, leadVars)}`, protectContent: protect });
    } else if (item.delivery_type === "vip_group" && item.vip_group_id) {
      const expireDate = (item.access_days || 0) > 0 ? Math.floor(Date.now() / 1000) + (item.access_days as number) * 86400 : undefined;
      try {
        const link = await tg.createChatInviteLink(item.vip_group_id, { memberLimit: 1, expireDate });
        await tg.sendMessage({
          chatId,
          text: `🎉 <b>${name}</b>\n\nToque no botão abaixo para entrar no grupo VIP.\n⚠️ O convite é único e só pode ser usado uma vez.`,
          replyMarkup: urlButtonMarkup("🚀 Entrar no grupo VIP", link),
          protectContent: protect,
        });
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
    const due = await db.select().from(simplifiedScheduledTasks)
      .where(and(eq(simplifiedScheduledTasks.status, "pending"), lte(simplifiedScheduledTasks.executeAt, new Date())));

    let processed = 0;
    for (const task of due) {
      try {
        await db.update(simplifiedScheduledTasks).set({ status: "processing" }).where(eq(simplifiedScheduledTasks.id, task.id));
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

  private async runDueTask(task: typeof simplifiedScheduledTasks.$inferSelect): Promise<void> {
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
        ? u.description.trim()
        : `🎁 <b>Oferta especial só pra você!</b>\n\n<b>${u.name}</b>\n\nAdicione agora por apenas <b>${priceLabel}</b>.`;
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
        ? d.description.trim()
        : `💡 <b>Última chance!</b>\n\nQue tal levar <b>${d.name}</b> por apenas <b>${priceLabel}</b>?`;
      const dStyle = telegramButtonStyle(d.style);
      await tg.sendMessage({
        chatId, text, protectContent: bot.protectContent,
        replyMarkup: { inline_keyboard: [[{ text: `✅ Quero! — ${priceLabel}`, callback_data: `sd_${task.refId}`, ...(dStyle ? { style: dStyle } : {}) }]] },
      });
    }
  }
}
