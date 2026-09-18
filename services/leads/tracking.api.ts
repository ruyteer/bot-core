import type { IncomingHttpHeaders } from "node:http";
import { api } from "encore.dev/api";
import { registerTrackingClick } from "./application/tracking-click.js";
import { trustedProxySecret } from "../config/secrets.js";

// Secret opcional (mesmo padrão de `nextAuthIssuer` em auth.handler.ts): se
// TRUSTED_PROXY_SECRET não estiver setado, `trustedProxySecret()` lança em
// ambiente deployado — trata como "proxy confiável desligado" em vez de
// derrubar o endpoint público.
function readOptionalSecret(fn: () => string): string {
  try {
    return fn() || "";
  } catch {
    return "";
  }
}

// Resolve o IP real do visitante a partir de X-Forwarded-For.
//
// O endpoint é público — qualquer um pode chamar `/r` direto e escrever
// QUALQUER valor no header, então confiar no PRIMEIRO IP da lista (como o
// código fazia antes) deixa o atacante forjar o IP gravado no lead.
//
// Na Railway, o proxy da própria plataforma ACRESCENTA o IP de quem conectou
// de fato no FINAL do X-Forwarded-For — esse último valor não é forjável por
// quem chama a API. A UI nova (nova-ui) chama esse endpoint do SERVIDOR dela
// e repassa o IP do visitante no mesmo header, então o formato real que
// chega aqui é: `[ip-que-a-UI-mandou, ip-do-servidor-da-UI-visto-pela-railway]`.
//
// Regra: só confia no penúltimo valor (o que a UI alega ser o IP do
// visitante) quando a chamada vier autenticada como a própria UI via
// `x-trusted-proxy-secret` batendo com `TRUSTED_PROXY_SECRET` — sem o secret
// configurado, ou sem o header batendo, usa sempre o último valor da lista
// (ou o IP da conexão TCP, se não houver X-Forwarded-For nenhum).
export function resolveClientIp(headers: IncomingHttpHeaders, socketRemoteAddress: string | undefined): string | null {
  const raw = headers["x-forwarded-for"];
  const xff = (Array.isArray(raw) ? raw.join(",") : raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const configuredSecret = readOptionalSecret(trustedProxySecret);
  const isTrustedCaller = !!configuredSecret && headers["x-trusted-proxy-secret"] === configuredSecret;

  if (isTrustedCaller && xff.length >= 2) {
    return xff[xff.length - 2];
  }

  if (xff.length > 0) {
    return xff[xff.length - 1];
  }

  return socketRemoteAddress ?? null;
}

// GET /r — destino dos links rastreáveis de tráfego pago. Público e sem auth:
// é a URL colada no anúncio (Meta/TikTok/Google), com as macros já substituídas
// pela plataforma no clique. Grava o clique e manda o visitante pro bot.
//
// `format=json` → responde { url } (usado pela página /r do app, que mantém o
// domínio próprio na barra do navegador). Sem format → 302 direto (permite usar
// a URL da API diretamente no anúncio, sem passar pelo frontend).
export const trackingRedirect = api.raw(
  { expose: true, method: "GET", path: "/r" },
  async (req, resp) => {
    const url = new URL(req.url ?? "/r", "http://localhost");
    const q = url.searchParams;

    const botId = (q.get("b") ?? "").trim();
    const wantsJson = q.get("format") === "json";

    const fail = (msg: string) => {
      if (wantsJson) {
        resp.writeHead(404, { "Content-Type": "application/json" });
        resp.end(JSON.stringify({ error: msg }));
      } else {
        resp.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        resp.end(msg);
      }
    };

    if (!botId || !/^[0-9a-f-]{36}$/i.test(botId)) {
      fail("link inválido");
      return;
    }

    const clientIp = resolveClientIp(req.headers, req.socket?.remoteAddress);

    try {
      const result = await registerTrackingClick({
        botId,
        platform:    q.get("p"),
        utmSource:   q.get("utm_source"),
        utmMedium:   q.get("utm_medium"),
        utmCampaign: q.get("utm_campaign"),
        utmContent:  q.get("utm_content"),
        utmTerm:     q.get("utm_term"),
        fbclid:      q.get("fbclid"),
        gclid:       q.get("gclid"),
        ttclid:      q.get("ttclid"),
        // Kwai não padroniza o nome do parâmetro entre docs/ferramentas.
        kwaiClickId: q.get("clickid") ?? q.get("click_id") ?? q.get("kwai_click_id"),
        clientIp,
        userAgent:   (req.headers["user-agent"] as string | undefined) ?? null,
      });

      if (!result) {
        fail("bot não encontrado");
        return;
      }

      if (wantsJson) {
        resp.writeHead(200, { "Content-Type": "application/json" });
        resp.end(JSON.stringify({ url: result.url }));
      } else {
        resp.writeHead(302, { Location: result.url });
        resp.end();
      }
    } catch (err) {
      console.error("[tracking] /r falhou:", err);
      fail("erro ao processar o link");
    }
  },
);
