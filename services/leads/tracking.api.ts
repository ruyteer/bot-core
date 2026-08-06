import { api } from "encore.dev/api";
import { registerTrackingClick } from "./application/tracking-click.js";

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

    const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();

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
        clientIp:    forwarded || req.socket?.remoteAddress || null,
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
