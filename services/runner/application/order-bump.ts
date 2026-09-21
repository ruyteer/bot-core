import { telegramButtonStyle } from "./telegram-button-style.js";
import { fmtBRL } from "./pix-messages.js";
import type { SimplifiedDeliveryItem } from "../../payments/domain/payment.entity.js";

/**
 * Card de order bump compartilhado. O simplificado grava textos em
 * `config.order_bumps_*`; o flow grava `bump_message` / `bump_skip_text` /
 * `bump_button_template` na oferta. Os callbacks são injetados pra cada
 * runner não pisar no prefixo do outro (`sb_` vs `ob:`).
 */

export function replaceOrderBumpVars(text: string, vars: { nome?: string; preco?: string }): string {
  if (!text) return text || "";
  return text
    .replace(/\{nome\}/gi, vars.nome || "")
    .replace(/\{(preco|valor)\}/gi, vars.preco || "");
}

function nonEmptyStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export interface OrderBumpItem {
  id: string;
  name: string;
  price: number;
  buttonLabel?: string;
  style?: unknown;
}

export function buildOrderBumpCard(opts: {
  items: OrderBumpItem[];
  introText?: string;
  skipText?: string;
  skipStyle?: unknown;
  addOneTemplate?: string;
  addOneStyle?: unknown;
  addAllTemplate?: string;
  addAllStyle?: unknown;
  callbackYes: string;
  callbackNo: string;
  callbackOne: (id: string) => string;
}): { text: string; replyMarkup: { inline_keyboard: Array<Array<Record<string, unknown>>> } } {
  const items = opts.items;
  const bumpsTotal = items.reduce((sum, item) => sum + Number(item.price || 0), 0);
  const text = nonEmptyStr(opts.introText) || "🎁 Adicione ao seu pedido:";
  const keyboard: Array<Array<Record<string, unknown>>> = [];

  if (items.length > 1) {
    for (const item of items) {
      const itemLabelTpl = nonEmptyStr(item.buttonLabel) || "➕ {nome} (+{preco})";
      const itemLabel = replaceOrderBumpVars(itemLabelTpl, { nome: item.name, preco: fmtBRL(item.price) });
      const style = telegramButtonStyle(item.style);
      keyboard.push([{ text: itemLabel, callback_data: opts.callbackOne(item.id), ...(style ? { style } : {}) }]);
    }
    const addAllTpl = nonEmptyStr(opts.addAllTemplate) || "✅ Adicionar tudo (+{preco})";
    const addAllStyle = telegramButtonStyle(opts.addAllStyle);
    keyboard.push([{ text: replaceOrderBumpVars(addAllTpl, { preco: fmtBRL(bumpsTotal) }), callback_data: opts.callbackYes, ...(addAllStyle ? { style: addAllStyle } : {}) }]);
  } else {
    const addOneTpl = nonEmptyStr(opts.addOneTemplate) || "✅ Adicionar (+{preco})";
    const addOneStyle = telegramButtonStyle(opts.addOneStyle);
    const first = items[0];
    keyboard.push([{
      text: replaceOrderBumpVars(addOneTpl, { nome: first?.name || "", preco: fmtBRL(bumpsTotal) }),
      callback_data: opts.callbackYes,
      ...(addOneStyle ? { style: addOneStyle } : {}),
    }]);
  }

  const declineLabel = nonEmptyStr(opts.skipText) || "Não, obrigado";
  const declineStyle = telegramButtonStyle(opts.skipStyle);
  keyboard.push([{ text: declineLabel, callback_data: opts.callbackNo, ...(declineStyle ? { style: declineStyle } : {}) }]);
  return { text, replyMarkup: { inline_keyboard: keyboard } };
}

export function flowBumpRawList(offer: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = offer.bumps;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

export function toDeliveryItemFromFlowBump(bump: Record<string, unknown>): SimplifiedDeliveryItem {
  const dt = (bump.delivery_type as string) || (bump.vip_group_id ? "vip_group" : "content");
  const kind = dt === "vip_group" ? "vip_group" : dt === "text" ? "text" : "content";
  return {
    name: String(bump.product_name || bump.name || "Produto"),
    delivery_type: kind,
    delivery_url: kind === "content" ? ((bump.delivery_url as string) ?? null) : null,
    delivery_text: kind === "text" ? ((bump.delivery_text as string) ?? null) : null,
    vip_group_id: kind === "vip_group" ? ((bump.vip_group_id as string) ?? null) : null,
    access_days: Number(bump.access_days || 0),
  };
}

export function pixConfigForOffer(nodeContent: Record<string, unknown>, offer: Record<string, unknown>): Record<string, unknown> {
  const blocks = nodeContent.blocks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block.type !== "offer") continue;
      const offers = block.offers as unknown[] | undefined;
      if (Array.isArray(offers) && offers.includes(offer)) {
        return { ...nodeContent, ...block };
      }
    }
  }
  return nodeContent;
}
