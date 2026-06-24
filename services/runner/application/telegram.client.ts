export interface SendMessageOptions {
  chatId:      string;
  text:        string;
  parseMode?:  "HTML" | "Markdown" | "MarkdownV2";
  replyMarkup?: unknown;
  protectContent?: boolean;
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

export class TelegramClient {
  constructor(private readonly token: string) {}

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    const json = await res.json() as { ok: boolean; result?: unknown };
    if (!json.ok) throw new Error(`Telegram ${method} failed`);
    return json.result;
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
    await this.call("sendPhoto", {
      chat_id:         opts.chatId,
      photo:           opts.photo,
      caption:         opts.caption,
      parse_mode:      opts.parseMode ?? "HTML",
      reply_markup:    opts.replyMarkup,
      protect_content: opts.protectContent ?? false,
    });
  }

  async sendDocument(chatId: string, document: string, caption?: string, protectContent = false): Promise<void> {
    await this.call("sendDocument", { chat_id: chatId, document, caption, protect_content: protectContent });
  }

  async sendVideo(chatId: string, video: string, caption?: string, protectContent = false): Promise<void> {
    await this.call("sendVideo", { chat_id: chatId, video, caption, protect_content: protectContent });
  }

  async sendAudio(chatId: string, audio: string, caption?: string, protectContent = false): Promise<void> {
    await this.call("sendAudio", { chat_id: chatId, audio, caption, protect_content: protectContent });
  }

  async sendVoice(chatId: string, voice: string, protectContent = false): Promise<void> {
    await this.call("sendVoice", { chat_id: chatId, voice, protect_content: protectContent });
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
    await this.call("sendMediaGroup", {
      chat_id:         chatId,
      media:           items.map((it) => ({
        type:       it.type,
        media:      it.media,
        ...(it.caption ? { caption: it.caption, parse_mode: "HTML" } : {}),
        ...(it.has_spoiler ? { has_spoiler: true } : {}),
      })),
      protect_content: protectContent,
    });
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
      [m.field]:       opts.url,
      parse_mode:      "HTML",
      reply_markup:    opts.replyMarkup,
      protect_content: opts.protect ?? false,
    };
    if (opts.caption && opts.type !== "voice") body.caption = opts.caption;
    if (opts.hasSpoiler && (opts.type === "image" || opts.type === "video")) body.has_spoiler = true;
    await this.call(m.endpoint, body);
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
