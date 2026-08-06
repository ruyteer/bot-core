// Motor de detecção passiva de conteúdo proibido. Só texto, palavra inteira.
// NÃO bloqueia nada — quem consome gera alerta para revisão manual do admin.

export interface KeywordEntry {
  keyword:  string;
  category: string;
}

export interface Match {
  keyword:  string;   // a palavra do dicionário que casou (forma normalizada)
  category: string;
  snippet:  string;   // ~120 chars ao redor do 1º casamento, no texto ORIGINAL
}

// minúscula, sem acento, sem pontuação (colapsa em espaço) — mesma normalização
// aplicada ao texto e às palavras do dicionário.
export function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // remove acentos
    .replace(/[^a-z0-9\s]/g, " ")                        // pontuação -> espaço
    .replace(/\s+/g, " ")
    .trim();
}

// Escapa uma keyword (já normalizada) para uso em regex.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Varre `rawText` contra o dicionário. Retorna 1 match por keyword que casar
 * (palavra inteira). O snippet é recortado do texto ORIGINAL, aproximando a
 * posição pela contagem de caracteres da versão normalizada.
 */
export function scanText(rawText: string, dict: KeywordEntry[]): Match[] {
  const text = rawText || "";
  const norm = normalize(text);
  if (!norm || dict.length === 0) return [];

  const out: Match[] = [];
  for (const { keyword, category } of dict) {
    const kw = normalize(keyword);
    if (!kw) continue;
    // palavra inteira: borda por não-alfanumérico (ou início/fim)
    const re = new RegExp(`(^|[^a-z0-9])(${escapeRegex(kw)})([^a-z0-9]|$)`);
    const m = re.exec(norm);
    if (!m) continue;
    // posição aproximada no texto original (norm e original têm comprimentos
    // parecidos, mas não idênticos — o snippet é só contexto pra revisão).
    const at = Math.max(0, (m.index ?? 0));
    const ratio = text.length && norm.length ? text.length / norm.length : 1;
    const origAt = Math.min(text.length, Math.round(at * ratio));
    const start = Math.max(0, origAt - 50);
    const snippet = text.slice(start, start + 120).replace(/\s+/g, " ").trim();
    out.push({ keyword: kw, category, snippet });
  }
  return out;
}
