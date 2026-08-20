// Cor do botão — suportada pelo Telegram desde o Bot API 9.4 (fev/2026):
// `style` em InlineKeyboardButton, só "primary"|"success"|"danger". A paleta
// do editor (buttonStyle.ts, no front) tem 3 opções — primary/constructive/
// destructive — mapeadas 1:1 pros valores do Telegram; qualquer outra coisa
// cai em undefined (omitido = estilo padrão do app do lead, igual a nunca ter
// tido cor nenhuma).
//
// Compartilhado entre os dois executores de funil (flow e simplificado) —
// os botões de ambos usam o mesmo campo `style` salvo no banco.
export function telegramButtonStyle(style: unknown): "primary" | "success" | "danger" | undefined {
  if (style === "primary") return "primary";
  if (style === "constructive") return "success";
  if (style === "destructive") return "danger";
  return undefined;
}

// ─── Whitelist server-side ────────────────────────────────────────────────────
// inlineButtons/offers (broadcasts) e inlineButtons/offerStyle (remarketing) chegam
// do cliente como JSON praticamente arbitrário nos endpoints de API, e `style`
// acaba indo parar direto no Telegram (Bot API 9.4) via telegramButtonStyle() acima
// no processamento do broadcast/remarketing. Qualquer valor fora dos 3 aceitos pelo
// editor é descartado aqui — nunca gravado como veio do cliente nem repassado cru
// pro Telegram. Compartilhado entre broadcasts.api.ts e remarketing.api.ts.
const VALID_BUTTON_STYLES = new Set(["primary", "constructive", "destructive"]);

export function sanitizeButtonStyle(style: unknown): "primary" | "constructive" | "destructive" | undefined {
  return typeof style === "string" && VALID_BUTTON_STYLES.has(style) ? (style as "primary" | "constructive" | "destructive") : undefined;
}

// Aplica a whitelist ao campo `style` de cada item de um array de botões
// (inline_buttons ou offers), preservando o resto do objeto como veio.
export function sanitizeButtonArray(arr: unknown): unknown[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => {
    if (!item || typeof item !== "object") return item;
    const { style, ...rest } = item as Record<string, unknown>;
    const clean = sanitizeButtonStyle(style);
    return clean ? { ...rest, style: clean } : rest;
  });
}
