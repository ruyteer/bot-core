import { encoreExternalUrl } from "../../config/secrets.js";

/**
 * Registro do webhook no Telegram.
 *
 * Vive fora dos use-cases porque tem DOIS chamadores com políticas de erro
 * diferentes: a criação de bot (onde falhar não pode desfazer o bot já
 * validado) e a reativação manual (onde falhar precisa virar erro para o
 * usuário ver). Uma função que devolve o resultado — em vez de lançar — deixa
 * cada chamador decidir, sem duplicar a chamada HTTP.
 */

export interface WebhookTarget {
  readonly botId:         string;
  readonly telegramToken: string;
  readonly webhookSecret: string;
}

export type WebhookResult =
  | { ok: true;  url: string }
  | { ok: false; reason: string };

/** Updates que o runner consome. Manter em sincronia com o handler do webhook. */
const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"];

export async function setTelegramWebhook(target: WebhookTarget): Promise<WebhookResult> {
  const baseUrl = encoreExternalUrl();
  if (!baseUrl) return { ok: false, reason: "ENCORE_EXTERNAL_URL not configured" };

  const url = `${baseUrl}/webhook/${target.botId}`;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${target.telegramToken}/setWebhook`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          secret_token:    target.webhookSecret,
          allowed_updates: ALLOWED_UPDATES,
        }),
      },
    );
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) return { ok: false, reason: json.description ?? "unknown" };
    return { ok: true, url };
  } catch (err) {
    // Rede fora do ar não pode derrubar a criação do bot: o token já foi
    // validado e o registro é retentável pelo botão "Reconectar".
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
