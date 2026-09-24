// Freio de abuso dos webhooks de pagamento (webhooks.ts). Os 4 endpoints são
// públicos e, desde a confirmação ativa, cada POST que casa um pagamento nosso
// vira uma consulta AUTENTICADA na API do gateway com a credencial do vendedor.
// Sem freio, um replay em loop gastaria a cota do vendedor no gateway (e
// derrubaria por rate limit do provedor os webhooks/conciliação legítimos).
//
// Mesmo padrão de leads/application/click-rate-limiter.ts: janela deslizante
// em memória por processo, sem dependência nova. Não precisa ser exato entre
// instâncias; um restart zerando a contagem é aceitável. O gateway legítimo
// que tomar 429 reenvia depois — e a conciliação cobre de qualquer jeito.

interface Limit { windowMs: number; max: number }

// Por IP de origem (último X-Forwarded-For = quem conectou no proxy da
// Railway): generoso, porque os gateways mandam TODOS os webhooks de todos os
// vendedores de poucos IPs.
export const WEBHOOK_IP_LIMIT: Limit = { windowMs: 60_000, max: 600 };
// Por pagamento: quantas consultas ao gateway um mesmo pagamento pode disparar
// via webhook. Uma venda legítima gera 2–4 webhooks (criado/pendente/pago).
export const WEBHOOK_PAYMENT_CHECK_LIMIT: Limit = { windowMs: 10 * 60_000, max: 6 };

const buckets = new Map<string, number[]>();

const PRUNE_INTERVAL_MS = 60_000;
const MAX_WINDOW_MS = Math.max(WEBHOOK_IP_LIMIT.windowMs, WEBHOOK_PAYMENT_CHECK_LIMIT.windowMs);
let lastPrune = 0;

function prune(now: number): void {
  for (const [key, ts] of buckets) {
    const recent = ts.filter((t) => now - t < MAX_WINDOW_MS);
    if (recent.length === 0) buckets.delete(key);
    else buckets.set(key, recent);
  }
}

function allow(key: string, limit: Limit): boolean {
  const now = Date.now();
  if (now - lastPrune > PRUNE_INTERVAL_MS) {
    prune(now);
    lastPrune = now;
  }
  const ts = (buckets.get(key) ?? []).filter((t) => now - t < limit.windowMs);
  if (ts.length >= limit.max) {
    buckets.set(key, ts);
    return false;
  }
  ts.push(now);
  buckets.set(key, ts);
  return true;
}

/** true = dentro do limite; false = responder 429 sem processar. */
export function allowWebhookFromIp(provider: string, ip: string | null | undefined): boolean {
  if (!ip) return true;
  return allow(`ip|${provider}|${ip}`, WEBHOOK_IP_LIMIT);
}

/** true = pode consultar o gateway por este pagamento agora. */
export function allowGatewayCheckForPayment(paymentId: string): boolean {
  return allow(`pay|${paymentId}`, WEBHOOK_PAYMENT_CHECK_LIMIT);
}

// Exposto só para teste.
export function _resetWebhookRateLimiterForTests(): void {
  buckets.clear();
  lastPrune = 0;
}
