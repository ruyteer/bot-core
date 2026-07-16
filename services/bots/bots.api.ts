import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { BotDrizzleRepository } from "./infrastructure/bot.drizzle.repository.js";
import { db } from "../shared/database.js";
import { botGroups, vipMembers, trackingPixels, conversionEvents } from "../shared/schema/index.js";
import { and, eq, desc, sql } from "drizzle-orm";
import { encrypt, decrypt } from "../shared/crypto.js";
import { CreateBotUseCase } from "./application/use-cases/create-bot.use-case.js";
import { UpdateBotUseCase } from "./application/use-cases/update-bot.use-case.js";
import { DeleteBotUseCase } from "./application/use-cases/delete-bot.use-case.js";
import { RegisterWebhookUseCase } from "./application/use-cases/register-webhook.use-case.js";
import { DeregisterWebhookUseCase } from "./application/use-cases/deregister-webhook.use-case.js";
import { SyncBotProfileUseCase } from "./application/use-cases/sync-bot-profile.use-case.js";
import type { BotWithStats } from "./domain/bot.entity.js";

const repo              = new BotDrizzleRepository();
const createBot         = new CreateBotUseCase(repo);
const updateBot         = new UpdateBotUseCase(repo);
const deleteBot         = new DeleteBotUseCase(repo);
const registerWebhook   = new RegisterWebhookUseCase(repo);
const deregisterWebhook = new DeregisterWebhookUseCase(repo);
const syncBotProfile    = new SyncBotProfileUseCase(repo);

// ─── Request / Response shapes ───────────────────────────────────────────────

interface CreateBotRequest {
  name:          string;
  telegramToken: string;
}

interface UpdateBotRequest {
  defaultGatewayId?: string | null;
  name?:          string;
  isActive?:      boolean;
  protectContent?:boolean;
}

interface BotResponse {
  id:               string;
  name:             string;
  telegramUsername: string | null;
  isActive:         boolean;
  protectContent:   boolean;
  defaultGatewayId: string | null;
  leadsCount:       number;
  salesCount:       number;
  createdAt:        string;
}

function toResponse(b: BotWithStats): BotResponse {
  return {
    id:               b.id,
    name:             b.name,
    telegramUsername: b.telegramUsername,
    isActive:         b.isActive,
    protectContent:   b.protectContent,
    defaultGatewayId: b.defaultGatewayId ?? null,
    leadsCount:       b.leadsCount,
    salesCount:       b.salesCount,
    createdAt:        b.createdAt.toISOString(),
  };
}

async function toResponseWithStats(bot: Awaited<ReturnType<typeof repo.findById>>): Promise<BotResponse> {
  if (!bot) throw new Error("bot not found");
  const list = await repo.findByUserId(bot.userId);
  const full = list.find((b) => b.id === bot.id)!;
  return toResponse(full);
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// GET /bots — substitui supabase.from("bots").select(...)
export const list = api(
  { method: "GET", path: "/bots", expose: true, auth: true },
  async (): Promise<{ bots: BotResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    const result = await repo.findByUserId(userId);
    return { bots: result.map(toResponse) };
  },
);

// POST /bots — substitui supabase.from("bots").insert(...) + setup-webhook Edge Function
export const create = api(
  { method: "POST", path: "/bots", expose: true, auth: true },
  async (req: CreateBotRequest): Promise<BotResponse> => {
    const { userID: userId } = getAuthData()!;
    const bot = await createBot.execute({ userId, name: req.name, telegramToken: req.telegramToken });
    return toResponseWithStats(bot);
  },
);

// PATCH /bots/:id
export const update = api(
  { method: "PATCH", path: "/bots/:id", expose: true, auth: true },
  async ({ id, ...req }: { id: string } & UpdateBotRequest): Promise<BotResponse> => {
    const { userID: userId } = getAuthData()!;
    const bot = await updateBot.execute(id, userId, req);
    return toResponseWithStats(bot);
  },
);

// DELETE /bots/:id
export const remove = api(
  { method: "DELETE", path: "/bots/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<void> => {
    const { userID: userId } = getAuthData()!;
    await deleteBot.execute(id, userId);
  },
);

// POST /bots/:id/webhook/activate — substitui setup-webhook Edge Function (action: activate)
export const activateWebhook = api(
  { method: "POST", path: "/bots/:id/webhook/activate", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    return registerWebhook.execute(id, userId);
  },
);

// DELETE /bots/:id/webhook — substitui setup-webhook Edge Function (action: deactivate)
export const deactivateWebhook = api(
  { method: "DELETE", path: "/bots/:id/webhook", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    return deregisterWebhook.execute(id, userId);
  },
);

// PATCH /bots/:id/profile — substitui update-bot-profile Edge Function
export const syncProfile = api(
  { method: "PATCH", path: "/bots/:id/profile", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<BotResponse> => {
    const { userID: userId } = getAuthData()!;
    const bot = await syncBotProfile.execute(id, userId);
    return toResponseWithStats(bot);
  },
);

// GET /bots/:id — single bot
export const get = api(
  { method: "GET", path: "/bots/:id", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<BotResponse> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    const bot = bots.find((b) => b.id === id);
    if (!bot) throw APIError.notFound("bot not found");
    return toResponse(bot);
  },
);

// GET /bots/:id/groups — list Telegram groups/channels for a bot
export const listGroups = api(
  { method: "GET", path: "/bots/:id/groups", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ groups: Array<{ id: string; name: string; telegramChatId: string; type: string }> }> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");
    const rows = await db.select().from(botGroups).where(eq(botGroups.botId, id));
    return {
      groups: rows.map((g) => ({
        id:             g.id,
        name:           g.name,
        telegramChatId: g.telegramChatId.toString(),
        type:           g.type,
      })),
    };
  },
);

// ─── Telegram profile helpers ─────────────────────────────────────────────────

async function tgCall(token: string, method: string, body?: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>;
}

interface TelegramProfileResponse {
  username:         string | null;
  name:             string;
  description:      string;
  shortDescription: string;
  photoBase64:      string | null;
}

// GET /bots/:id/telegram-profile
export const getTelegramProfile = api(
  { method: "GET", path: "/bots/:id/telegram-profile", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<TelegramProfileResponse> => {
    const { userID: userId } = getAuthData()!;
    const bot = await repo.findInternalById(id);
    if (!bot || bot.userId !== userId) throw APIError.notFound("bot not found");

    const [meRes, nameRes, descRes, shortRes] = await Promise.all([
      tgCall(bot.telegramToken, "getMe"),
      tgCall(bot.telegramToken, "getMyName"),
      tgCall(bot.telegramToken, "getMyDescription"),
      tgCall(bot.telegramToken, "getMyShortDescription"),
    ]);

    const username = (meRes.result as any)?.username ?? null;
    const botUserId = (meRes.result as any)?.id;

    let photoBase64: string | null = null;
    if (botUserId) {
      const photosRes = await tgCall(bot.telegramToken, "getUserProfilePhotos", { user_id: botUserId, limit: 1 });
      const photos = (photosRes.result as any)?.photos?.[0];
      if (photos?.length > 0) {
        const fileId = photos[photos.length - 1].file_id;
        const fileRes = await tgCall(bot.telegramToken, "getFile", { file_id: fileId });
        const filePath = (fileRes.result as any)?.file_path;
        if (filePath) {
          const imgRes = await fetch(`https://api.telegram.org/file/bot${bot.telegramToken}/${filePath}`);
          const buf = await imgRes.arrayBuffer();
          photoBase64 = Buffer.from(buf).toString("base64");
        }
      }
    }

    return {
      username,
      name:             (nameRes.result as any)?.name ?? "",
      description:      (descRes.result as any)?.description ?? "",
      shortDescription: (shortRes.result as any)?.short_description ?? "",
      photoBase64,
    };
  },
);

interface UpdateTelegramProfileRequest {
  id:               string;
  name?:            string;
  description?:     string;
  shortDescription?: string;
  photoBase64?:     string;
  removePhoto?:     boolean;
}

// PATCH /bots/:id/telegram-profile
export const updateTelegramProfile = api(
  { method: "PATCH", path: "/bots/:id/telegram-profile", expose: true, auth: true },
  async ({ id, name, description, shortDescription, photoBase64, removePhoto }: UpdateTelegramProfileRequest): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const bot = await repo.findInternalById(id);
    if (!bot || bot.userId !== userId) throw APIError.notFound("bot not found");

    const tasks: Promise<unknown>[] = [];

    if (name !== undefined)             tasks.push(tgCall(bot.telegramToken, "setMyName", { name }));
    if (description !== undefined)      tasks.push(tgCall(bot.telegramToken, "setMyDescription", { description }));
    if (shortDescription !== undefined) tasks.push(tgCall(bot.telegramToken, "setMyShortDescription", { short_description: shortDescription }));

    if (removePhoto) {
      tasks.push(tgCall(bot.telegramToken, "deleteMyProfilePhotos"));
    } else if (photoBase64) {
      const buf = Buffer.from(photoBase64, "base64");
      const blob = new Blob([buf], { type: "image/jpeg" });
      const form = new FormData();
      form.append("photo", blob, "photo.jpg");
      tasks.push(
        fetch(`https://api.telegram.org/bot${bot.telegramToken}/setMyProfilePhoto`, { method: "POST", body: form })
          .then((r) => r.json()),
      );
    }

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) throw APIError.internal("some telegram operations failed");

    return { ok: true };
  },
);

// GET /bots/:id/groups/:chatId/info — fetch group title/description/photo from Telegram
export const getGroupInfo = api(
  { method: "GET", path: "/bots/:id/groups/:chatId/info", expose: true, auth: true },
  async ({ id, chatId }: { id: string; chatId: string }): Promise<{ title: string; description: string; photoBase64: string | null }> => {
    const { userID: userId } = getAuthData()!;
    const bot = await repo.findInternalById(id);
    if (!bot || bot.userId !== userId) throw APIError.notFound("bot not found");

    const [chatRes, photoRes] = await Promise.all([
      tgCall(bot.telegramToken, "getChat", { chat_id: chatId }),
      tgCall(bot.telegramToken, "getChatPhoto" as any, { chat_id: chatId }).catch(() => ({ ok: false, result: null })),
    ]);

    const chat = chatRes.result as any;
    let photoBase64: string | null = null;
    const fileId = (chatRes.result as any)?.photo?.small_file_id;
    if (fileId) {
      const fileRes = await tgCall(bot.telegramToken, "getFile", { file_id: fileId });
      const filePath = (fileRes.result as any)?.file_path;
      if (filePath) {
        const imgRes = await fetch(`https://api.telegram.org/file/bot${bot.telegramToken}/${filePath}`);
        const buf = await imgRes.arrayBuffer();
        photoBase64 = Buffer.from(buf).toString("base64");
      }
    }

    return {
      title:       chat?.title ?? "",
      description: chat?.description ?? "",
      photoBase64,
    };
  },
);

interface UpdateGroupInfoRequest {
  id: string;
  chatId: string;
  title?: string;
  description?: string;
  photoBase64?: string | null;
  removePhoto?: boolean;
}

// PATCH /bots/:id/groups/:chatId/info — update group title/description/photo via Telegram
export const updateGroupInfo = api(
  { method: "PATCH", path: "/bots/:id/groups/:chatId/info", expose: true, auth: true },
  async ({ id, chatId, title, description, photoBase64, removePhoto }: UpdateGroupInfoRequest): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const bot = await repo.findInternalById(id);
    if (!bot || bot.userId !== userId) throw APIError.notFound("bot not found");

    const tasks: Promise<unknown>[] = [];
    if (title !== undefined)       tasks.push(tgCall(bot.telegramToken, "setChatTitle", { chat_id: chatId, title }));
    if (description !== undefined) tasks.push(tgCall(bot.telegramToken, "setChatDescription", { chat_id: chatId, description }));

    if (removePhoto) {
      tasks.push(tgCall(bot.telegramToken, "deleteChatPhoto", { chat_id: chatId }));
    } else if (photoBase64) {
      const buf = Buffer.from(photoBase64, "base64");
      const blob = new Blob([buf], { type: "image/jpeg" });
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("photo", blob, "photo.jpg");
      tasks.push(
        fetch(`https://api.telegram.org/bot${bot.telegramToken}/setChatPhoto`, { method: "POST", body: form })
          .then((r) => r.json()),
      );
    }

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) throw APIError.internal("some telegram operations failed");

    return { ok: true };
  },
);

// ─── VIP Members ─────────────────────────────────────────────────────────────

interface VipMemberResponse {
  id:             string;
  botId:          string;
  telegramChatId: string;
  username:       string | null;
  firstName:      string | null;
  lastName:       string | null;
  isBlocked:      boolean;
  joinedAt:       string;
}

// GET /bots/:id/members?page=1&pageSize=25&status=active
export const listMembers = api(
  { method: "GET", path: "/bots/:id/members", expose: true, auth: true },
  async ({ id, page, pageSize, status }: { id: string; page?: number; pageSize?: number; status?: string }): Promise<{ members: VipMemberResponse[]; total: number }> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");

    const ps = pageSize ?? 25;
    const p  = page ?? 1;
    const offset = (p - 1) * ps;

    const conditions = [eq(vipMembers.botId, id)];
    if (status) conditions.push(eq(vipMembers.isBlocked, status === "blocked"));

    const [rows, countResult] = await Promise.all([
      db.select().from(vipMembers).where(and(...conditions)).orderBy(desc(vipMembers.joinedAt)).limit(ps).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(vipMembers).where(and(...conditions)),
    ]);

    return {
      members: rows.map((m) => ({
        id:             m.id,
        botId:          m.botId,
        telegramChatId: m.telegramChatId.toString(),
        username:       m.username,
        firstName:      m.firstName,
        lastName:       m.lastName,
        isBlocked:      m.isBlocked,
        joinedAt:       m.joinedAt.toISOString(),
      })),
      total: countResult[0]?.count ?? 0,
    };
  },
);

// GET /bots/:id/members/counts
export const memberCounts = api(
  { method: "GET", path: "/bots/:id/members/counts", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ active: number; blocked: number }> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");

    const [activeRes, blockedRes] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(vipMembers).where(and(eq(vipMembers.botId, id), eq(vipMembers.isBlocked, false))),
      db.select({ count: sql<number>`count(*)::int` }).from(vipMembers).where(and(eq(vipMembers.botId, id), eq(vipMembers.isBlocked, true))),
    ]);

    return {
      active:  activeRes[0]?.count ?? 0,
      blocked: blockedRes[0]?.count ?? 0,
    };
  },
);

// ─── Tracking Pixels ──────────────────────────────────────────────────────────

interface PixelResponse {
  id:          string;
  provider:    string;
  pixelId:     string;
  isActive:    boolean;
}

// GET /bots/:id/pixels
export const listPixels = api(
  { method: "GET", path: "/bots/:id/pixels", expose: true, auth: true },
  async ({ id }: { id: string }): Promise<{ pixels: PixelResponse[] }> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");
    const rows = await db.select().from(trackingPixels).where(eq(trackingPixels.botId, id));
    return { pixels: rows.map((p) => ({ id: p.id, provider: p.provider, pixelId: p.pixelId, isActive: p.isActive })) };
  },
);

// PUT /bots/:id/pixels/:provider — upsert pixel config (create or update)
export const upsertPixel = api(
  { method: "PUT", path: "/bots/:id/pixels/:provider", expose: true, auth: true },
  async ({ id, provider, pixelId, accessToken, isActive }: { id: string; provider: string; pixelId: string; accessToken?: string | null; isActive?: boolean }): Promise<PixelResponse> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");

    const encryptedToken = accessToken ? encrypt(accessToken) : null;

    const existing = await db.select().from(trackingPixels).where(and(eq(trackingPixels.botId, id), eq(trackingPixels.provider, provider))).limit(1);
    let row: typeof trackingPixels.$inferSelect;
    if (existing.length) {
      [row] = await db.update(trackingPixels).set({
        pixelId,
        ...(encryptedToken !== null ? { accessToken: encryptedToken } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        updatedAt: new Date(),
      }).where(eq(trackingPixels.id, existing[0].id)).returning();
    } else {
      [row] = await db.insert(trackingPixels).values({ botId: id, provider, pixelId, accessToken: encryptedToken, isActive: isActive ?? true }).returning();
    }

    return { id: row.id, provider: row.provider, pixelId: row.pixelId, isActive: row.isActive };
  },
);

// GET /bots/:id/pixels/:provider — get single pixel (returns access token for editing)
export const getPixel = api(
  { method: "GET", path: "/bots/:id/pixels/:provider", expose: true, auth: true },
  async ({ id, provider }: { id: string; provider: string }): Promise<{ found: boolean; id: string; provider: string; pixelId: string; accessToken: string | null; isActive: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");
    const rows = await db.select().from(trackingPixels).where(and(eq(trackingPixels.botId, id), eq(trackingPixels.provider, provider))).limit(1);
    if (!rows.length) return { found: false, id: "", provider, pixelId: "", accessToken: null, isActive: false };
    const p = rows[0];
    return { found: true, id: p.id, provider: p.provider, pixelId: p.pixelId, accessToken: p.accessToken ? decrypt(p.accessToken) : null, isActive: p.isActive };
  },
);

// DELETE /bots/:id/pixels/:provider
export const deletePixel = api(
  { method: "DELETE", path: "/bots/:id/pixels/:provider", expose: true, auth: true },
  async ({ id, provider }: { id: string; provider: string }): Promise<void> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");
    await db.delete(trackingPixels).where(and(eq(trackingPixels.botId, id), eq(trackingPixels.provider, provider)));
  },
);

// GET /bots/:id/pixels/:provider/events — list conversion events for a pixel
export const listPixelEvents = api(
  { method: "GET", path: "/bots/:id/pixels/:provider/events", expose: true, auth: true },
  async ({ id, provider }: { id: string; provider: string }): Promise<{ events: Array<{ id: string; eventName: string; status: string; httpStatus: number | null; errorMessage: string | null; paymentId: string | null; createdAt: string }> }> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");
    const rows = await db.select().from(conversionEvents)
      .where(and(eq(conversionEvents.botId, id), eq(conversionEvents.provider, provider)))
      .orderBy(desc(conversionEvents.createdAt))
      .limit(20);
    return {
      events: rows.map((e) => ({
        id:           e.id,
        eventName:    e.eventName,
        status:       e.status,
        httpStatus:   e.httpStatus,
        errorMessage: e.errorMessage,
        paymentId:    e.paymentId,
        createdAt:    e.createdAt.toISOString(),
      })),
    };
  },
);

// POST /bots/:id/pixels/:provider/test — queue a test conversion event
export const testPixel = api(
  { method: "POST", path: "/bots/:id/pixels/:provider/test", expose: true, auth: true },
  async ({ id, provider }: { id: string; provider: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const bots = await repo.findByUserId(userId);
    if (!bots.some((b) => b.id === id)) throw APIError.notFound("bot not found");
    const pixel = await db.select().from(trackingPixels)
      .where(and(eq(trackingPixels.botId, id), eq(trackingPixels.provider, provider))).limit(1);
    if (!pixel.length) throw APIError.notFound("pixel not configured");
    await db.insert(conversionEvents).values({
      botId:     id,
      provider,
      eventName: "PageView",
      eventId:   crypto.randomUUID(),
      status:    "pending",
    });
    return { ok: true };
  },
);

// POST /bots/:id/members/:memberId/ban — kick member from all their VIP groups + mark blocked
export const banMember = api(
  { method: "POST", path: "/bots/:id/members/:memberId/ban", expose: true, auth: true },
  async ({ id, memberId }: { id: string; memberId: string }): Promise<{ ok: boolean }> => {
    const { userID: userId } = getAuthData()!;
    const bot = await repo.findInternalById(id);
    if (!bot || bot.userId !== userId) throw APIError.notFound("bot not found");

    const member = await db.select().from(vipMembers).where(and(eq(vipMembers.id, memberId), eq(vipMembers.botId, id))).limit(1);
    if (!member.length) throw APIError.notFound("member not found");

    const m = member[0];
    const telegramUserId = m.telegramChatId.toString();

    if (m.groupId) {
      const group = await db.select().from(botGroups).where(eq(botGroups.id, m.groupId)).limit(1);
      if (group.length) {
        await tgCall(bot.telegramToken, "banChatMember", { chat_id: group[0].telegramChatId.toString(), user_id: parseInt(telegramUserId) });
      }
    }

    await db.update(vipMembers).set({ isBlocked: true, updatedAt: new Date() }).where(eq(vipMembers.id, memberId));
    return { ok: true };
  },
);
