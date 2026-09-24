import { webhookVerifyStrict } from "../../config/secrets.js";
import type { Provider } from "../domain/gateway.entity.js";

// ── Modo da verificação ativa por gateway (entrada gradual) ─────────────────
// As consultas de status (gateway-status.ts) seguem o check-payments do
// sistema antigo, mas não foram exercitadas contra as APIs reais neste código.
// Se a de um gateway estiver errada (endpoint, auth, formato), o modo estrito
// deixaria TODAS as vendas dele pendentes. Por isso cada gateway começa em:
//
// - "shadow" (padrão): a verificação roda e, quando o gateway RESPONDE um
//   status, ele vale (pago confirma; pendente/cancelado com payload dizendo
//   pago NÃO confirma — é o que barra webhook forjado). Quando a verificação
//   fica INDISPONÍVEL (rede, timeout, HTTP de erro, resposta sem status,
//   credencial, BuckPay legado sem chave, 404), cai no caminho do payload
//   (comportamento anterior) e registra `verification_unavailable:<motivo>`.
// - "strict": sem fallback — indisponível responde 503 pro gateway reenviar.
//
// Liga o estrito por gateway com WEBHOOK_VERIFY_STRICT=syncpay,buckpay (ou
// "all"). Vazio/ausente = todos em sombra. Lido a cada webhook.

export type VerifyMode = "shadow" | "strict";

function readStrictList(): string[] {
  let raw = "";
  try { raw = webhookVerifyStrict() || ""; } catch { raw = ""; } // secret opcional
  return raw.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
}

export function verifyModeFor(provider: Provider): VerifyMode {
  const list = readStrictList();
  return list.includes("all") || list.includes(provider) ? "strict" : "shadow";
}
