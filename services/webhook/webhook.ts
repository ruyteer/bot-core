import { api } from "encore.dev/api";
import { eq } from "drizzle-orm";
import { db } from "../shared/database.js";
import { bots } from "../shared/schema/index.js";
import { telegramUpdateReceived, type TelegramUpdate } from "../shared/events/index.js";

// Recebe updates do Telegram para um bot específico
export const handle = api.raw(
  { expose: true, method: "POST", path: "/webhook/:botId" },
  async (req, resp) => {
    const botId = (req.url ?? "").split("/webhook/")[1]?.split("?")[0] ?? "";

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot || !bot.isActive) {
      resp.writeHead(404);
      resp.end();
      return;
    }

    // Verifica o secret do Telegram (HMAC)
    const secret = req.headers["x-telegram-bot-api-secret-token"];
    if (secret !== bot.webhookSecret) {
      resp.writeHead(401);
      resp.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    let update: TelegramUpdate;
    try {
      update = JSON.parse(Buffer.concat(chunks).toString()) as TelegramUpdate;
    } catch {
      resp.writeHead(400);
      resp.end();
      return;
    }

    // Responde 200 imediatamente — Telegram tem timeout curto
    resp.writeHead(200);
    resp.end("ok");

    // Publica o evento para processamento assíncrono
    await telegramUpdateReceived.publish({ botId, update });
  },
);

// Havia aqui um alias legacy POST /bots/:botId/webhook/register. Removido:
// o parâmetro `:botId` conflitava com o `/bots/:id/...` do serviço de bots
// (o roteador não aceita dois nomes na mesma posição), então a rota nunca foi
// registrada — e ela buscava o bot só por id, sem checar o dono. Renomear o
// parâmetro teria ATIVADO um endpoint que deixa qualquer usuário autenticado
// registrar webhook em bot alheio. Quem faz isso é bots.activateWebhook, que
// valida a posse. Nenhum chamador no frontend.
