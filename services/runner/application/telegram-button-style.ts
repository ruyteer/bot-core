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
