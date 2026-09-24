import { TelegramClient, pixCopyButtonMarkup } from "./telegram.client.js";

/**
 * Mensagens do PIX (QR + copia-e-cola + texto depois). Uma função só para o
 * runner do flow e o do simplificado — os fallbacks continuam DIFERENTES de
 * propósito: funil flow antigo sem `pix_*` tem que gerar as mesmas chamadas
 * de Telegram de hoje (💠 + R$ x.xx); o simplificado mantém o 🛒.
 *
 * Variáveis: `{nome}`, `{valor}`, `{produto}`, `{descricao}`, `{mensagem}`.
 * Alias de caption: `pix_qr_caption` (flow / UI antiga) ou `pix_caption_template`
 * (simplificado).
 */

export function fmtBRL(reais: number): string {
  return Number(reais || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function replacePixVariables(
  text: string,
  vars: { nome?: string; valor?: string; produto?: string; descricao?: string; mensagem?: string },
): string {
  if (!text) return text || "";
  // Escapa cada VALOR antes de entrar no lugar do placeholder — o template
  // (pix_caption_template etc.) é do dono do bot e pode ter <b>/<code> de
  // propósito, mas nome/produto podem vir de first_name do lead ou de texto
  // livre do painel: cru, um `<`/`&` quebra o parser HTML do Telegram e a
  // mensagem de PIX nem chega (Achado 5 da auditoria).
  return text
    .replace(/\{nome\}/gi, escapeHtml(vars.nome || ""))
    .replace(/\{valor\}/gi, escapeHtml(vars.valor || ""))
    .replace(/\{produto\}/gi, escapeHtml(vars.produto || ""))
    .replace(/\{descricao\}/gi, escapeHtml(vars.descricao || ""))
    .replace(/\{mensagem\}/gi, escapeHtml(vars.mensagem || ""));
}

function asNonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function captionTemplateOf(payCfg: Record<string, unknown>): string | undefined {
  return asNonEmpty(payCfg.pix_caption_template) ?? asNonEmpty(payCfg.pix_qr_caption);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendPixMessages(opts: {
  tg: TelegramClient;
  chatId: string;
  pixCode: string;
  qrPhoto: string;
  amountReais: number;
  productName: string;
  payCfg: Record<string, unknown>;
  protect: boolean;
  leadName?: string;
  fallback: "simplified" | "flow";
}): Promise<void> {
  const { tg, chatId, pixCode, qrPhoto, amountReais, productName, payCfg, protect } = opts;
  const pixVars = {
    nome: opts.leadName ?? "",
    valor: fmtBRL(amountReais),
    produto: productName,
    descricao: "",
    mensagem: "",
  };

  const customCaption = captionTemplateOf(payCfg);
  const customCopy = asNonEmpty(payCfg.pix_copy_text);
  const customAfter = asNonEmpty(payCfg.pix_after_text);

  const qrCaption = customCaption
    ? replacePixVariables(customCaption, pixVars)
    : opts.fallback === "flow"
      ? `💠 <b>${escapeHtml(productName)}</b>\nValor: R$ ${amountReais.toFixed(2)}\n\nPague com o PIX copia-e-cola abaixo 👇`
      : `🛒 ${escapeHtml(productName)}\n\n💰 Total: ${fmtBRL(amountReais)}\n\nEscaneie o QR Code para pagar!`;

  // Flow sem pix_copy_text: só o <code> (comportamento legado). Simplificado
  // sempre tem um texto de copia (configurado ou fallback).
  const copyText = customCopy
    ? replacePixVariables(customCopy, pixVars)
    : opts.fallback === "flow"
      ? null
      : "👆 Ou copie o código acima e cole no app do seu banco.";

  const sendMode = payCfg.pix_send_mode === "combined" ? "combined" : "separate";
  const pixCodeHtml = `<code>${escapeHtml(pixCode)}</code>`;
  const copyButtonMarkup = pixCopyButtonMarkup(
    pixCode,
    typeof payCfg.pix_copy_button_label === "string" ? payCfg.pix_copy_button_label : undefined,
  );

  if (sendMode === "combined") {
    const extra = copyText ? `\n\n${copyText}` : "";
    await tg.sendPhoto({
      chatId,
      photo: qrPhoto,
      caption: `${qrCaption}\n\n${pixCodeHtml}${extra}`,
      protectContent: protect,
      replyMarkup: copyButtonMarkup,
    });
  } else {
    await tg.sendPhoto({ chatId, photo: qrPhoto, caption: qrCaption, protectContent: protect });
    const text = copyText ? `${pixCodeHtml}\n\n${copyText}` : pixCodeHtml;
    await tg.sendMessage({ chatId, text, protectContent: protect, replyMarkup: copyButtonMarkup });
  }

  if (customAfter) {
    await tg.sendMessage({
      chatId,
      text: replacePixVariables(customAfter, pixVars),
      protectContent: protect,
    });
  }
}
