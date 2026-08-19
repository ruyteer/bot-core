import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { pushSubscriptions, userNotificationPreferences } from "../shared/schema/index.js";
import { createProfile } from "../../test/helpers/seed.js";

// web-push abre conexão HTTPS de verdade (não passa pelo mock de fetch), então
// é mockado aqui: os testes verificam a lógica de despacho, não a criptografia.
const sendNotification = vi.fn();
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

const { sendPushToUser } = await import("./application/send-push.use-case.js");

async function seedSub(userId: string, endpoint: string) {
  const db = await testDb();
  const [row] = await db.insert(pushSubscriptions)
    .values({ userId, endpoint, p256dh: "p256dh-test", auth: "auth-test" })
    .returning();
  return row;
}

function withVapid() {
  process.env.TEST_SECRET_VAPID_PUBLIC_KEY  = "public-test-key";
  process.env.TEST_SECRET_VAPID_PRIVATE_KEY = "private-test-key";
}

beforeEach(() => {
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  delete process.env.TEST_SECRET_VAPID_PUBLIC_KEY;
  delete process.env.TEST_SECRET_VAPID_PRIVATE_KEY;
});

describe("sendPushToUser", () => {
  it("sem VAPID configurado, não envia (e não quebra)", async () => {
    const userId = await createProfile();
    await seedSub(userId, "https://push.example/no-vapid");
    const r = await sendPushToUser(userId, { eventType: "sale", title: "Venda" });
    expect(r.skipped).toBe("no-vapid");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("envia para todos os dispositivos inscritos do usuário", async () => {
    withVapid();
    const userId = await createProfile();
    await seedSub(userId, "https://push.example/a");
    await seedSub(userId, "https://push.example/b");

    const r = await sendPushToUser(userId, { eventType: "sale", title: "Venda aprovada", body: "R$ 10,00" });

    expect(r.sent).toBe(2);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(sendNotification.mock.calls[0][1] as string);
    expect(payload).toMatchObject({ title: "Venda aprovada", body: "R$ 10,00", event_type: "sale" });
  });

  it("não envia para outro usuário", async () => {
    withVapid();
    const userA = await createProfile();
    const userB = await createProfile();
    await seedSub(userB, "https://push.example/do-b");

    const r = await sendPushToUser(userA, { eventType: "sale", title: "Venda" });
    expect(r.skipped).toBe("no-subs");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("respeita push desligado nas preferências", async () => {
    withVapid();
    const userId = await createProfile();
    await seedSub(userId, "https://push.example/off");
    const db = await testDb();
    await db.insert(userNotificationPreferences).values({ userId, pushEnabled: false });

    const r = await sendPushToUser(userId, { eventType: "sale", title: "Venda" });
    expect(r.skipped).toBe("pref-disabled");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("respeita o evento desligado em eventPrefs", async () => {
    withVapid();
    const userId = await createProfile();
    await seedSub(userId, "https://push.example/evt");
    const db = await testDb();
    await db.insert(userNotificationPreferences).values({ userId, eventPrefs: { sale: false } });

    expect((await sendPushToUser(userId, { eventType: "sale", title: "x" })).skipped).toBe("pref-disabled");
    // outro tipo de evento continua passando
    expect((await sendPushToUser(userId, { eventType: "admin_announcement", title: "x" })).sent).toBe(1);
  });

  it("respeita o evento desligado quando eventPrefs guarda { enabled, soundEnabled } (formato salvo por updateEventPreferences)", async () => {
    withVapid();
    const userId = await createProfile();
    await seedSub(userId, "https://push.example/evt-obj");
    const db = await testDb();
    await db.insert(userNotificationPreferences).values({
      userId,
      eventPrefs: { sale_approved: { enabled: false, soundEnabled: true } },
    });

    expect((await sendPushToUser(userId, { eventType: "sale_approved", title: "x" })).skipped).toBe("pref-disabled");
    // outro evento, não desligado, continua passando
    expect((await sendPushToUser(userId, { eventType: "pix_generated", title: "x" })).sent).toBe(1);
  });

  it("inscrição expirada (410) é removida do banco", async () => {
    withVapid();
    const userId = await createProfile();
    await seedSub(userId, "https://push.example/gone");
    sendNotification.mockRejectedValueOnce({ statusCode: 410 });

    const r = await sendPushToUser(userId, { eventType: "sale", title: "Venda" });

    expect(r.removed).toBe(1);
    expect(r.sent).toBe(0);
    const db = await testDb();
    const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    expect(left.length).toBe(0);
  });

  it("erro transitório conta como falha mas mantém a inscrição", async () => {
    withVapid();
    const userId = await createProfile();
    await seedSub(userId, "https://push.example/flaky");
    sendNotification.mockRejectedValueOnce({ statusCode: 500 });

    const r = await sendPushToUser(userId, { eventType: "sale", title: "Venda" });

    expect(r.failed).toBe(1);
    expect(r.removed).toBe(0);
    const db = await testDb();
    expect((await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))).length).toBe(1);
  });
});
