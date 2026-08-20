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

// removePushSubscription usa getAuthData (via ~encore/auth) para restringir a
// remoção ao dono da inscrição — mockado aqui para controlar o usuário
// autenticado por teste, já que fora do runtime `encore test` esse módulo não
// existe (ver test/stubs/encore-auth.ts, que só cobre encore.dev/auth).
let currentAuthUserId: string | null = null;
vi.mock("~encore/auth", () => ({
  getAuthData: () => (currentAuthUserId ? { userID: currentAuthUserId } : null),
}));
const { removePushSubscription, savePushSubscription } = await import("./notifications.api.js");

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

describe("removePushSubscription", () => {
  // O stub de api() usado nos testes (test/stubs/encore-api.ts) devolve o
  // handler cru, sem roteamento HTTP — então estes testes cobrem só a lógica
  // de posse/isolamento do handler (delete filtrado por userId + id), não o
  // contrato HTTP real (Encore decodificando `id` do path de um DELETE
  // /notifications/push-subscription/:id). Esse round-trip não tem cobertura
  // automatizada neste harness; validar manualmente ou via teste de
  // integração `encore test`.
  it("remove a inscrição do próprio usuário a partir do `id` recebido (lógica de posse)", async () => {
    const userId = await createProfile();
    const sub = await seedSub(userId, "https://push.example/mine");
    currentAuthUserId = userId;

    await removePushSubscription({ id: sub.id });

    const db = await testDb();
    const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    expect(left).toHaveLength(0);
  });

  it("não remove a inscrição de outro usuário, mesmo passando o id exato dele", async () => {
    const userA = await createProfile();
    const userB = await createProfile();
    const subA = await seedSub(userA, "https://push.example/of-a");
    currentAuthUserId = userB; // autenticado como B, tentando remover o id de A

    await removePushSubscription({ id: subA.id });

    const db = await testDb();
    const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userA));
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(subA.id);
  });

  it("id inexistente não afeta outras inscrições do usuário", async () => {
    const userId = await createProfile();
    const sub = await seedSub(userId, "https://push.example/kept");
    currentAuthUserId = userId;

    await removePushSubscription({ id: "00000000-0000-0000-0000-000000000000" });

    const db = await testDb();
    const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(sub.id);
  });

  it("id malformado (não-uuid, ex.: a string literal 'undefined' vinda de um bug no frontend) retorna erro controlado em vez de deixar subir o erro cru do driver Postgres", async () => {
    const userId = await createProfile();
    await seedSub(userId, "https://push.example/malformed-id");
    currentAuthUserId = userId;

    await expect(removePushSubscription({ id: "undefined" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });
});

describe("savePushSubscription", () => {
  it("retorna o id da inscrição inserida", async () => {
    const userId = await createProfile();
    currentAuthUserId = userId;

    const result = await savePushSubscription({
      endpoint: "https://push.example/new",
      p256dh: "p256dh-test",
      auth: "auth-test",
    });

    expect(result.ok).toBe(true);
    const db = await testDb();
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/new"));
    expect(result.id).toBe(row.id);
  });

  it("retorna o mesmo id ao atualizar uma inscrição existente (upsert pelo endpoint)", async () => {
    const userId = await createProfile();
    currentAuthUserId = userId;
    const sub = await seedSub(userId, "https://push.example/upsert");

    const result = await savePushSubscription({
      endpoint: sub.endpoint,
      p256dh: "p256dh-updated",
      auth: "auth-updated",
    });

    expect(result.id).toBe(sub.id);
  });
});
