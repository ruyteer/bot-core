import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { mediaCache } from "../../shared/schema/index.js";

export interface SendMessageOptions {
  chatId:      string;
  text:        string;
  parseMode?:  "HTML" | "Markdown" | "MarkdownV2";
  replyMarkup?: unknown;
  protectContent?: boolean;
}

// Teclado inline com um único botão que abre uma URL (ex.: link de convite de
// grupo). Um link de convite `https://t.me/+...` funciona direto como botão URL.
// Botão converte melhor que o link cru colado no texto.
export function urlButtonMarkup(text: string, url: string): { inline_keyboard: Array<Array<{ text: string; url: string }>> } {
  return { inline_keyboard: [[{ text, url }]] };
}

export interface SendPhotoOptions {
  chatId:   string;
  photo:    string;   // URL or file_id
  caption?: string;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  replyMarkup?: unknown;
  protectContent?: boolean;
}

export interface AnswerCallbackOptions {
  callbackQueryId: string;
  text?: string;
}

// Tipos de mídia cacheáveis e como extrair o file_id da resposta do Telegram.
type MediaKind = "photo" | "video" | "document" | "audio" | "voice";

function extractFileId(kind: MediaKind, message: unknown): string | null {
  const m = message as Record<string, any> | null;
  if (!m) return null;
  if (kind === "photo") {
    const sizes = m.photo as Array<{ file_id: string }> | undefined;
    return sizes?.length ? sizes[sizes.length - 1].file_id : null;
  }
  return (m[kind] as { file_id?: string } | undefined)?.file_id ?? null;
}

// URLs dinâmicas (geradas por request) não devem entrar no cache — ex.: QR de
// PIX via qrserver, que é única por cobrança.
function isCacheableUrl(url: string): boolean {
  return /^https?:\/\//.test(url) && !url.includes("api.qrserver.com");
}

export class TelegramClient {
  // `botId` habilita o cache de file_id (mídia enviada por URL uma vez fica
  // instantânea nas próximas — o Telegram não precisa baixar o arquivo de novo).
  constructor(private readonly token: string, private readonly botId?: string) {}

  // ── Cache de file_id ────────────────────────────────────────────────────────
  // Usa a tabela media_cache (herdada do backend antigo): chave url_hash =
  // sha256("kind:url") — o kind entra no hash porque o unique é (bot_id, url_hash)
  // e a mesma URL pode virar file_ids diferentes como photo vs document.

  private urlHash(kind: MediaKind, url: string): string {
    return createHash("sha256").update(`${kind}:${url}`).digest("hex");
  }

  private async cachedFileId(kind: MediaKind, url: string): Promise<string | null> {
    if (!this.botId || !isCacheableUrl(url)) return null;
    try {
      const [row] = await db.select().from(mediaCache).where(and(
        eq(mediaCache.botId, this.botId), eq(mediaCache.urlHash, this.urlHash(kind, url)),
      )).limit(1);
      return row?.telegramFileId ?? null;
    } catch { return null; }
  }

  private async storeFileId(kind: MediaKind, url: string, result: unknown): Promise<void> {
    if (!this.botId || !isCacheableUrl(url)) return;
    const fileId = extractFileId(kind, result);
    if (!fileId) return;
    try {
      await db.insert(mediaCache)
        .values({ botId: this.botId, urlHash: this.urlHash(kind, url), telegramFileId: fileId, mediaType: kind })
        .onConflictDoUpdate({
          target: [mediaCache.botId, mediaCache.urlHash],
          set: { telegramFileId: fileId, mediaType: kind },
        });
    } catch { /* cache é best-effort */ }
  }

  private async invalidateFileId(kind: MediaKind, url: string): Promise<void> {
    if (!this.botId) return;
    try {
      await db.delete(mediaCache).where(and(
        eq(mediaCache.botId, this.botId), eq(mediaCache.urlHash, this.urlHash(kind, url)),
      ));
    } catch { /* best-effort */ }
  }

  // Envia mídia usando o cache: tenta file_id; se o Telegram recusar (file_id
  // invalidado), refaz com a URL original e atualiza o cache.
  private async callMedia(
    method: string, kind: MediaKind, field: string, url: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const cached = await this.cachedFileId(kind, url);
    if (cached) {
      try {
        await this.call(method, { ...body, [field]: cached });
        return;
      } catch {
        await this.invalidateFileId(kind, url);
      }
    }
    const result = await this.call(method, { ...body, [field]: url });
    await this.storeFileId(kind, url, result);
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    // Timeout obrigatório: sem isso, um fetch que trava (TCP black hole, Telegram
    // lento) deixaria o await pendurado pra sempre — e, no scheduler, isso congela
    // toda a fila (delays/broadcasts/remarketing). 20s é folgado p/ a API do TG.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      const json = await res.json() as { ok: boolean; result?: unknown };
      if (!json.ok) throw new Error(`Telegram ${method} failed`);
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendMessage(opts: SendMessageOptions): Promise<void> {
    await this.call("sendMessage", {
      chat_id:         opts.chatId,
      text:            opts.text,
      parse_mode:      opts.parseMode ?? "HTML",
      reply_markup:    opts.replyMarkup,
      protect_content: opts.protectContent ?? false,
    });
  }

  async sendPhoto(opts: SendPhotoOptions): Promise<void> {
    await this.callMedia("sendPhoto", "photo", "photo", opts.photo, {
      chat_id:         opts.chatId,
      caption:         opts.caption,
      parse_mode:      opts.parseMode ?? "HTML",
      reply_markup:    opts.replyMarkup,
      protect_content: opts.protectContent ?? false,
    });
  }

  async sendDocument(chatId: string, document: string, caption?: string, protectContent = false): Promise<void> {
    await this.callMedia("sendDocument", "document", "document", document, { chat_id: chatId, caption, protect_content: protectContent });
  }

  async sendVideo(chatId: string, video: string, caption?: string, protectContent = false): Promise<void> {
    await this.callMedia("sendVideo", "video", "video", video, { chat_id: chatId, caption, protect_content: protectContent });
  }

  async sendAudio(chatId: string, audio: string, caption?: string, protectContent = false): Promise<void> {
    await this.callMedia("sendAudio", "audio", "audio", audio, { chat_id: chatId, caption, protect_content: protectContent });
  }

  async sendVoice(chatId: string, voice: string, protectContent = false): Promise<void> {
    await this.callMedia("sendVoice", "voice", "voice", voice, { chat_id: chatId, protect_content: protectContent });
  }

  // Busca metadados de um chat (título, tipo). Retorna null se a API falhar
  // (ex.: bot sem acesso). Usado p/ nomear grupos/canais salvos.
  async getChat(chatId: string): Promise<{ id: number; type: string; title?: string } | null> {
    try {
      return await this.call("getChat", { chat_id: chatId }) as { id: number; type: string; title?: string };
    } catch {
      return null;
    }
  }

  // Indicador de "digitando…"/"gravando áudio…" etc. Best-effort (não lança).
  async sendChatAction(chatId: string, action: string): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action }).catch(() => {});
  }

  async answerCallbackQuery(opts: AnswerCallbackOptions): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: opts.callbackQueryId,
      text:              opts.text,
    });
  }

  // Álbum: 2+ fotos/vídeos numa só mensagem. caption (HTML) só no 1º item.
  // reply_markup NÃO é suportado pelo Telegram em sendMediaGroup.
  async sendMediaGroup(
    chatId: string,
    items: Array<{ type: "photo" | "video"; media: string; caption?: string; has_spoiler?: boolean }>,
    protectContent = false,
  ): Promise<void> {
    // Resolve cada item pelo cache de file_id (quando houver).
    const resolved = await Promise.all(items.map(async (it) => ({
      item: it,
      media: (await this.cachedFileId(it.type, it.media)) ?? it.media,
    })));
    const body = (list: Array<{ item: typeof items[number]; media: string }>) => ({
      chat_id: chatId,
      media: list.map(({ item, media }) => ({
        type:       item.type,
        media,
        ...(item.caption ? { caption: item.caption, parse_mode: "HTML" } : {}),
        ...(item.has_spoiler ? { has_spoiler: true } : {}),
      })),
      protect_content: protectContent,
    });

    const storeAll = async (list: Array<{ item: typeof items[number]; media: string }>, result: unknown) => {
      const msgs = result as unknown[] | undefined;
      await Promise.all(list.map(({ item, media }, i) =>
        media === item.media ? this.storeFileId(item.type, item.media, msgs?.[i]) : Promise.resolve(),
      ));
    };

    try {
      const result = await this.call("sendMediaGroup", body(resolved));
      await storeAll(resolved, result);
    } catch (err) {
      const cachedOnes = resolved.filter((r) => r.media !== r.item.media);
      if (cachedOnes.length === 0) throw err;
      // Algum file_id do cache pode ter sido invalidado — limpa e refaz por URL.
      await Promise.all(cachedOnes.map((r) => this.invalidateFileId(r.item.type, r.item.media)));
      const plain = items.map((item) => ({ item, media: item.media }));
      const result = await this.call("sendMediaGroup", body(plain));
      await storeAll(plain, result);
    }
  }

  // Mídia única genérica (foto/vídeo/áudio/voz) com caption HTML, spoiler, teclado
  // e protect — usado pelo bloco de mídia do funil simplificado.
  async sendSingleMedia(
    chatId: string,
    opts: { type: string; url: string; caption?: string; hasSpoiler?: boolean; replyMarkup?: unknown; protect?: boolean },
  ): Promise<void> {
    const map: Record<string, { endpoint: string; field: string }> = {
      image:    { endpoint: "sendPhoto", field: "photo" },
      video:    { endpoint: "sendVideo", field: "video" },
      audio:    { endpoint: "sendAudio", field: "audio" },
      voice:    { endpoint: "sendVoice", field: "voice" },
    };
    const m = map[opts.type] ?? map.image;
    const body: Record<string, unknown> = {
      chat_id:         chatId,
      parse_mode:      "HTML",
      reply_markup:    opts.replyMarkup,
      protect_content: opts.protect ?? false,
    };
    if (opts.caption && opts.type !== "voice") body.caption = opts.caption;
    if (opts.hasSpoiler && (opts.type === "image" || opts.type === "video")) body.has_spoiler = true;
    await this.callMedia(m.endpoint, m.field as MediaKind, m.field, opts.url, body);
  }

  async editMessageReplyMarkup(chatId: string, messageId: number, replyMarkup: unknown): Promise<void> {
    await this.call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId, reply_markup: replyMarkup,
    }).catch(() => {});
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
  }

  // Gera um link de convite p/ entrega de oferta "grupo VIP". `memberLimit: 1`
  // garante que o link é de uso único; `expireDate` (epoch em segundos) limita
  // o acesso quando a oferta define dias de acesso.
  async createChatInviteLink(
    chatId: string,
    opts?: { memberLimit?: number; expireDate?: number },
  ): Promise<string> {
    const result = await this.call("createChatInviteLink", {
      chat_id:      chatId,
      member_limit: opts?.memberLimit,
      expire_date:  opts?.expireDate,
    }) as { invite_link: string };
    return result.invite_link;
  }
}
