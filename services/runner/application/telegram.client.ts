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
}
