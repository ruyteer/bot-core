import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { pushSubscriptions, userNotificationPreferences } from "../../shared/schema/index.js";
import { vapidPublicKey, vapidPrivateKey, vapidSubject } from "../../config/secrets.js";

// Porte do `notifications-dispatch` do backend antigo (Supabase Edge Functions).
// Na migração para o Encore só as metades de INSCRIÇÃO foram portadas: o painel
// registrava o service worker e salvava a inscrição em push_subscriptions, mas
// nada nunca enviava um push. Sem isto, notificação no navegador não funciona.

export interface PushPayload {
  eventType: string;              // 'sale' | 'admin_announcement' | ...
  title:     string;
  body?:     string;
  /** Vai para `notification.data` no service worker (url de clique, imagem...). */
  data?:     Record<string, unknown>;
  /** false = não tocar o som de caixa registradora no cliente. */
  sound?:    boolean;
}

export interface PushResult {
  sent:    number;
  failed:  number;
  removed: number;              // inscrições expiradas que foram apagadas
  skipped?: "no-vapid" | "pref-disabled" | "no-subs";
}

function vapidConfigured(): boolean {
  try {
    return !!vapidPublicKey() && !!vapidPrivateKey();
  } catch {
    return false; // secret não definido no ambiente
  }
}

function subjectOrDefault(): string {
  let raw = "";
  try { raw = (vapidSubject() || "").trim(); } catch { /* secret ausente */ }
  if (!raw) return "mailto:admin@orionbot.app";
  if (/^(mailto:|https?:\/\/)/i.test(raw)) return raw;
  return raw.includes("@") ? `mailto:${raw}` : "mailto:admin@orionbot.app";
}

/**
 * Envia um push para todos os dispositivos inscritos de um usuário.
 *
 * Nunca lança: notificação é acessório e não pode derrubar o fluxo que a
 * disparou (uma venda, por exemplo). Falhas são logadas e devolvidas no retorno.
 * Inscrições que o navegador já descartou (404/410) são removidas do banco.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushResult> {
  const empty: PushResult = { sent: 0, failed: 0, removed: 0 };

  if (!vapidConfigured()) {
    console.warn("[push] VAPID não configurado — envio ignorado");
    return { ...empty, skipped: "no-vapid" };
  }

  // Preferências: o padrão é habilitado. Só pula quando o usuário desligou
  // explicitamente o canal de push ou este tipo de evento.
  const [pref] = await db.select().from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userId, userId));
  if (pref) {
    if (pref.pushEnabled === false) return { ...empty, skipped: "pref-disabled" };
    const events = (pref.eventPrefs ?? {}) as Record<string, unknown>;
    if (events[payload.eventType] === false) return { ...empty, skipped: "pref-disabled" };
  }

  const subs = await db.select().from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  if (subs.length === 0) return { ...empty, skipped: "no-subs" };

  webpush.setVapidDetails(subjectOrDefault(), vapidPublicKey(), vapidPrivateKey());

  const body = JSON.stringify({
    title:      payload.title,
    body:       payload.body ?? "",
    event_type: payload.eventType,
    sound:      payload.sound !== false,
    data:       payload.data ?? {},
  });

  let sent = 0, failed = 0, removed = 0;

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 60, urgency: "high", contentEncoding: "aes128gcm" },
      );
      sent++;
    } catch (err) {
      const status = Number((err as { statusCode?: number })?.statusCode ?? 0);
      // 404/410: o navegador descartou a inscrição (app desinstalado, permissão
      // revogada). Guardá-la só geraria falha em todo envio futuro.
      if (status === 404 || status === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
        removed++;
        return;
      }
      failed++;
      console.error(`[push] falha ao enviar (status ${status}):`, (err as Error)?.message ?? err);
    }
  }));

  return { sent, failed, removed };
}
