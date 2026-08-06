import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { db } from "../shared/database.js";
import {
  adminNotifications,
  adminNotificationRecipients,
  userNotificationPreferences,
  pushSubscriptions,
} from "../shared/schema/index.js";
import { eq, and, isNull, or } from "drizzle-orm";
import { vapidPublicKey } from "../config/secrets.js";

// ─── Response shapes ─────────────────────────────────────────────────────────

interface NotificationResponse {
  id:          string;
  title:       string;
  body:        string;
  audience:    string;
  displayMode: string;
  imageUrl:    string | null;
  isActive:    boolean;
  requireAck:  boolean;
  readAt:      string | null;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
  createdAt:   string;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// GET /notifications/mine — notifications for the current user
export const listMine = api(
  { method: "GET", path: "/notifications/mine", expose: true, auth: true },
  async (): Promise<{ notifications: NotificationResponse[] }> => {
    const { userID: userId } = getAuthData()!;

    // Get active notifications targeted to all users or this user specifically
    const notifications = await db
      .select({
        id:             adminNotifications.id,
        title:          adminNotifications.title,
        body:           adminNotifications.body,
        audience:       adminNotifications.audience,
        displayMode:    adminNotifications.displayMode,
        imageUrl:       adminNotifications.imageUrl,
        isActive:       adminNotifications.isActive,
        requireAck:     adminNotifications.requireAck,
        createdAt:      adminNotifications.createdAt,
        readAt:         adminNotificationRecipients.readAt,
        acknowledgedAt: adminNotificationRecipients.acknowledgedAt,
        dismissedAt:    adminNotificationRecipients.dismissedAt,
      })
      .from(adminNotifications)
      .leftJoin(
        adminNotificationRecipients,
        and(
          eq(adminNotificationRecipients.notificationId, adminNotifications.id),
          eq(adminNotificationRecipients.userId, userId),
        ),
      )
      .where(
        and(
          eq(adminNotifications.isActive, true),
          isNull(adminNotificationRecipients.dismissedAt),
        ),
      )
      .orderBy(adminNotifications.createdAt);

    return {
      notifications: notifications.map((n) => ({
        id:             n.id,
        title:          n.title,
        body:           n.body,
        audience:       n.audience,
        displayMode:    n.displayMode,
        imageUrl:       n.imageUrl,
        isActive:       n.isActive,
        requireAck:     n.requireAck,
        readAt:         n.readAt?.toISOString() ?? null,
        acknowledgedAt: n.acknowledgedAt?.toISOString() ?? null,
        dismissedAt:    n.dismissedAt?.toISOString() ?? null,
        createdAt:      n.createdAt.toISOString(),
      })),
    };
  },
);

// POST /notifications/read-all
export const markAllRead = api(
  { method: "POST", path: "/notifications/read-all", expose: true, auth: true },
  async (): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const unread = await db
      .select({ notificationId: adminNotifications.id })
      .from(adminNotifications)
      .leftJoin(
        adminNotificationRecipients,
        and(
          eq(adminNotificationRecipients.notificationId, adminNotifications.id),
          eq(adminNotificationRecipients.userId, userId),
        ),
      )
      .where(
        and(
          eq(adminNotifications.isActive, true),
          isNull(adminNotificationRecipients.readAt),
        ),
      );

    for (const row of unread) {
      await db.insert(adminNotificationRecipients)
        .values({ notificationId: row.notificationId, userId, readAt: new Date() })
        .onConflictDoUpdate({
          target: [adminNotificationRecipients.notificationId, adminNotificationRecipients.userId],
          set: { readAt: new Date() },
        });
    }
    return { ok: true };
  },
);

// POST /notifications/:id/read
export const markRead = api(
  { method: "POST", path: "/notifications/:id/read", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await db.insert(adminNotificationRecipients)
      .values({ notificationId: id, userId, readAt: new Date() })
      .onConflictDoUpdate({
        target: [adminNotificationRecipients.notificationId, adminNotificationRecipients.userId],
        set: { readAt: new Date() },
      });
    return { ok: true };
  },
);

// POST /notifications/:id/acknowledge
export const acknowledge = api(
  { method: "POST", path: "/notifications/:id/acknowledge", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await db.insert(adminNotificationRecipients)
      .values({ notificationId: id, userId, acknowledgedAt: new Date(), readAt: new Date() })
      .onConflictDoUpdate({
        target: [adminNotificationRecipients.notificationId, adminNotificationRecipients.userId],
        set: { acknowledgedAt: new Date(), readAt: new Date() },
      });
    return { ok: true };
  },
);

// POST /notifications/:id/dismiss
export const dismiss = api(
  { method: "POST", path: "/notifications/:id/dismiss", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await db.insert(adminNotificationRecipients)
      .values({ notificationId: id, userId, dismissedAt: new Date(), readAt: new Date() })
      .onConflictDoUpdate({
        target: [adminNotificationRecipients.notificationId, adminNotificationRecipients.userId],
        set: { dismissedAt: new Date(), readAt: new Date() },
      });
    return { ok: true };
  },
);

// GET /notifications/preferences
export const getPreferences = api(
  { method: "GET", path: "/notifications/preferences", expose: true, auth: true },
  async (): Promise<{ pushEnabled: boolean; emailEnabled: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const rows = await db.select().from(userNotificationPreferences).where(eq(userNotificationPreferences.userId, userId)).limit(1);
    if (!rows.length) return { pushEnabled: true, emailEnabled: true };
    return { pushEnabled: rows[0].pushEnabled, emailEnabled: rows[0].emailEnabled };
  },
);

// PATCH /notifications/preferences
export const updatePreferences = api(
  { method: "PATCH", path: "/notifications/preferences", expose: true, auth: true },
  async ({ pushEnabled, emailEnabled }: { pushEnabled?: boolean; emailEnabled?: boolean }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await db.insert(userNotificationPreferences)
      .values({ userId, pushEnabled: pushEnabled ?? true, emailEnabled: emailEnabled ?? true })
      .onConflictDoUpdate({
        target: [userNotificationPreferences.userId],
        set: {
          ...(pushEnabled !== undefined ? { pushEnabled } : {}),
          ...(emailEnabled !== undefined ? { emailEnabled } : {}),
          updatedAt: new Date(),
        },
      });
    return { ok: true };
  },
);

// POST /notifications/push-subscription
// GET /notifications/vapid-key — chave pública VAPID para o navegador se inscrever.
// Fica no backend (e não chumbada no frontend) para que trocar o par de chaves
// não exija um novo deploy do painel: o service worker já reinscreve sozinho
// quando a applicationServerKey muda.
export const getVapidKey = api(
  { method: "GET", path: "/notifications/vapid-key", expose: true, auth: true },
  async (): Promise<{ publicKey: string }> => {
    let key = "";
    try { key = vapidPublicKey() || ""; } catch { key = ""; }
    return { publicKey: key };
  },
);

export const savePushSubscription = api(
  { method: "POST", path: "/notifications/push-subscription", expose: true, auth: true },
  async ({ endpoint, p256dh, auth }: { endpoint: string; p256dh: string; auth: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    await db.insert(pushSubscriptions)
      .values({ userId, endpoint, p256dh, auth })
      .onConflictDoUpdate({
        target: [pushSubscriptions.endpoint],
        set: { p256dh, auth },
      });
    return { ok: true };
  },
);

// DELETE /notifications/push-subscription
export const removePushSubscription = api(
  { method: "DELETE", path: "/notifications/push-subscription", expose: true, auth: true },
  async ({ endpoint }: { endpoint: string }): Promise<void> => {
    const { userID: userId } = getAuthData()!;
    await db.delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
  },
);

// GET /notifications/event-preferences — per-event push preferences
export const getEventPreferences = api(
  { method: "GET", path: "/notifications/event-preferences", expose: true, auth: true },
  async (): Promise<{ prefs: Record<string, { enabled: boolean; soundEnabled: boolean }> }> => {
    const { userID: userId } = getAuthData()!;
    const rows = await db.select().from(userNotificationPreferences).where(eq(userNotificationPreferences.userId, userId)).limit(1);
    const prefs = (rows[0]?.eventPrefs ?? {}) as Record<string, { enabled: boolean; soundEnabled: boolean }>;
    return { prefs };
  },
);

// PATCH /notifications/event-preferences — update per-event push preferences
export const updateEventPreferences = api(
  { method: "PATCH", path: "/notifications/event-preferences", expose: true, auth: true },
  async ({ eventType, enabled, soundEnabled }: { eventType: string; enabled?: boolean; soundEnabled?: boolean }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const rows = await db.select().from(userNotificationPreferences).where(eq(userNotificationPreferences.userId, userId)).limit(1);
    const existing = (rows[0]?.eventPrefs ?? {}) as Record<string, { enabled: boolean; soundEnabled: boolean }>;
    const current = existing[eventType] ?? { enabled: true, soundEnabled: true };
    const next: Record<string, { enabled: boolean; soundEnabled: boolean }> = {
      ...existing,
      [eventType]: {
        enabled:      enabled      !== undefined ? enabled      : current.enabled,
        soundEnabled: soundEnabled !== undefined ? soundEnabled : current.soundEnabled,
      },
    };
    await db.insert(userNotificationPreferences)
      .values({ userId, pushEnabled: true, emailEnabled: true, eventPrefs: next })
      .onConflictDoUpdate({
        target: [userNotificationPreferences.userId],
        set: { eventPrefs: next, updatedAt: new Date() },
      });
    return { ok: true };
  },
);
