// Freio anti-replay para GET /r (tracking.api.ts): o link de tráfego pago é
// público e qualquer um pode repetir o clique de um anúncio publicado —
// cada hit faz SELECT (bot) + INSERT (tracking_clicks), então um replay em
// loop infla relatório de campanha e armazenamento sem custo pro atacante.
//
// Contador em memória por processo, sem dependência nova: não precisa ser
// exato entre múltiplas instâncias (o objetivo é conter replay/reload
// abusivo, não ser um rate limit de borda) e um restart perdendo a contagem
// é aceitável — o pior caso é permitir alguns cliques a mais, nunca bloquear
// um visitante real.
const WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const MAX_CLICKS_PER_WINDOW = 5;  // clique legítimo de um mesmo IP no mesmo bot raramente passa disso; acima é replay/bot batendo no link.

const hits = new Map<string, number[]>();

function keyFor(ip: string, botId: string): string {
  return `${ip}|${botId}`;
}

// Limpeza preguiçosa (sem setInterval pro processo inteiro): o custo de
// varrer entradas velhas fica embutido na própria checagem, no máximo uma
// vez por PRUNE_INTERVAL_MS.
const PRUNE_INTERVAL_MS = 60 * 1000;
let lastPrune = 0;

function prune(now: number): void {
  for (const [key, timestamps] of hits) {
    const recent = timestamps.filter((t) => now - t < WINDOW_MS);
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
  }
}

/**
 * true = dentro do limite (pode gravar um clique novo); false = estourou a
 * janela — quem chama deve reaproveitar o último clique gravado em vez de
 * inserir outro.
 */
export function allowClick(ip: string, botId: string): boolean {
  const now = Date.now();
  if (now - lastPrune > PRUNE_INTERVAL_MS) {
    prune(now);
    lastPrune = now;
  }

  const key = keyFor(ip, botId);
  const timestamps = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (timestamps.length >= MAX_CLICKS_PER_WINDOW) {
    hits.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  hits.set(key, timestamps);
  return true;
}

// Exposto só para teste (reseta o estado entre casos que usam IP/bot fixos).
export function _resetClickRateLimiterForTests(): void {
  hits.clear();
  lastPrune = 0;
}

export const CLICK_RATE_LIMIT = { windowMs: WINDOW_MS, maxPerWindow: MAX_CLICKS_PER_WINDOW };
