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

// Botão inline "copiar código PIX" usando `copy_text` do teclado inline — o
// mecanismo de cópia do próprio app do Telegram, que funciona em todos os
// clientes recentes. Substituiu o bloco `<pre><code>` (tap-to-copy), que não
// aparecia/funcionava em vários celulares. Sempre anexado a QUALQUER PIX.
export const PIX_COPY_BUTTON_LABEL = "📋 Copiar código PIX";

export function pixCopyButtonMarkup(
  pixCode: string,
  label?: string,
): { inline_keyboard: Array<Array<{ text: string; copy_text: { text: string } }>> } {
  return { inline_keyboard: [[{ text: label || PIX_COPY_BUTTON_LABEL, copy_text: { text: pixCode } }]] };
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

// Erro da API do Telegram com o código e a descrição REAIS. O erro genérico
// ("Telegram sendPhoto failed") escondeu um incidente inteiro de 429 em
// produção — sem o código, rate limit e bot bloqueado eram indistinguíveis.
export class TelegramApiError extends Error {
  constructor(
    method: string,
    public readonly errorCode?: number,
    description?: string,
    public readonly retryAfter?: number,
  ) {
    super(
      `Telegram ${method} failed` +
      (errorCode ? ` [${errorCode}]` : "") +
      (description ? `: ${description}` : "") +
      (retryAfter ? ` (retry_after=${retryAfter}s)` : ""),
    );
    this.name = "TelegramApiError";
  }
  get isRateLimit(): boolean { return this.errorCode === 429; }
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

// ── Retry/backoff (item de auditoria: cliente sem retry) ────────────────────
// Este client é usado por TODO o backend (funis, remarketing, disparos) —
// inclusive no tick RÁPIDO de delays (3s). Por isso o retry aqui é
// deliberadamente conservador:
//
// - 429 com retry_after PEQUENO (<=RATE_LIMIT_INLINE_RETRY_MAX_SEC): provável
//   throttle momentâneo — vale esperar exatamente o retry_after e tentar mais
//   uma vez (uma única vez). 429 com retry_after maior (penalidade real de
//   flood) NÃO é retentado aqui: propaga pro chamador, que decide melhor —
//   runner.ts já tem cooldown por bot pro resto do lote de delays (o teste
//   "429 põe o bot em cooldown" depende de UMA chamada só antes do cooldown
//   assumir), e o disparo em massa tem seu próprio ritmo/backoff. Como o
//   Telegram RESPONDEU (a requisição não ficou ambígua), retenta pra
//   qualquer método, mesmo os que não são idempotentes.
// - 5xx explícito do Telegram: mesma lógica — é uma resposta de verdade (não
//   um timeout), então também retenta pra qualquer método.
// - Erro de rede/timeout (fetch falhou, abort, DNS...): AMBÍGUO — não dá pra
//   saber se o Telegram chegou a processar a requisição antes da conexão
//   cair. Retentar aqui pode DUPLICAR o efeito (mensagem enviada 2x, link de
//   convite de uso único criado 2x). Por isso só retenta quando o método é
//   explicitamente marcado como seguro pra repetir (`idempotent: true`) —
//   uma releitura, uma ação puramente local no chat (apagar, editar teclado)
//   ou algo que não duplica nada visível ao repetir. Todo método de ENVIO ou
//   CRIAÇÃO (sendMessage, sendPhoto, createChatInviteLink, etc.) é
//   NÃO-idempotente por padrão — precisa ser explicitamente marcado do
//   contrário, o que é a escolha conservadora certa pra qualquer método novo.
// - 401/403/400: definitivos (token inválido, bot bloqueado, chat inexistente)
//   — nunca retentados, propagam na primeira tentativa.
const RATE_LIMIT_INLINE_RETRY_MAX_SEC = 2;
const TRANSIENT_MAX_ATTEMPTS = 3; // 1ª tentativa + 2 retries
const TRANSIENT_BACKOFF_MS = 200; // 200ms, depois 400ms

function isDefinitiveTelegramError(errorCode: number | undefined): boolean {
  return errorCode === 401 || errorCode === 403 || errorCode === 400;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTelegramRetry<T>(fn: () => Promise<T>, idempotent: boolean): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TelegramApiError) {
        if (isDefinitiveTelegramError(err.errorCode)) throw err;
        if (err.isRateLimit) {
          const retryAfter = err.retryAfter;
          const canRetryInline = attempt === 1 && retryAfter != null && retryAfter <= RATE_LIMIT_INLINE_RETRY_MAX_SEC;
          if (!canRetryInline) throw err;
          await sleep(retryAfter * 1000);
          continue;
        }
        // 5xx: resposta explícita do Telegram, não uma ambiguidade de rede —
        // seguro retentar mesmo pra métodos não-idempotentes.
        const isServerError = err.errorCode != null && err.errorCode >= 500;
        if (!isServerError || attempt >= TRANSIENT_MAX_ATTEMPTS) throw err;
        await sleep(TRANSIENT_BACKOFF_MS * attempt);
        continue;
      }
      // Erro de rede/timeout (fetch falhou, abort, DNS...) — não sabemos se o
      // Telegram processou antes da conexão cair. Só retenta se o método foi
      // marcado como seguro pra repetir.
      if (!idempotent || attempt >= TRANSIENT_MAX_ATTEMPTS) throw err;
      await sleep(TRANSIENT_BACKOFF_MS * attempt);
    }
  }
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
      } catch (err) {
        // 429 não é file_id inválido: repetir com a URL só dobraria a carga
        // no rate limit. Propaga para o chamador reagendar.
        if (err instanceof TelegramApiError && err.isRateLimit) throw err;
        await this.invalidateFileId(kind, url);
      }
    }
    const result = await this.call(method, { ...body, [field]: url });
    await this.storeFileId(kind, url, result);
  }

  // `idempotent: true` habilita retry também em erro de rede/timeout (ver
  // withTelegramRetry) — só passe isso pra métodos onde repetir a chamada não
  // duplica efeito nenhum visível ao usuário/chat.
  private async call(method: string, body: Record<string, unknown>, opts?: { idempotent?: boolean }): Promise<unknown> {
    return withTelegramRetry(() => this.rawCall(method, body), opts?.idempotent ?? false);
  }

  private async rawCall(method: string, body: Record<string, unknown>): Promise<unknown> {
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
      const json = await res.json() as {
        ok: boolean; result?: unknown;
        error_code?: number; description?: string;
        parameters?: { retry_after?: number };
      };
      if (!json.ok) {
        throw new TelegramApiError(method, json.error_code, json.description, json.parameters?.retry_after);
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  // Mesmo tratamento de erro/timeout de `call`, mas com corpo multipart (upload
  // de arquivo) em vez de JSON — a Bot API espera multipart para binário.
  private async callMultipart(method: string, form: FormData, opts?: { idempotent?: boolean }): Promise<unknown> {
    return withTelegramRetry(() => this.rawCallMultipart(method, form), opts?.idempotent ?? false);
  }

  private async rawCallMultipart(method: string, form: FormData): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        body:   form,
        signal: controller.signal,
      });
      const json = await res.json() as {
        ok: boolean; result?: unknown;
        error_code?: number; description?: string;
        parameters?: { retry_after?: number };
      };
      if (!json.ok) {
        throw new TelegramApiError(method, json.error_code, json.description, json.parameters?.retry_after);
      }
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

  // Envia uma foto a partir de bytes já decodificados (ex.: data URL recebida
  // da UI) via multipart — a Bot API não aceita data URL no campo `photo` de
  // um corpo JSON, só `file_id` ou URL http(s) (mesma limitação resolvida para
  // setChatPhoto/setMyProfilePhoto em telegram-profile.ts). Sem cache de
  // file_id aqui: cada upload é um binário novo, não uma URL estável para
  // servir de chave.
  async sendPhotoFile(opts: {
    chatId: string; buffer: Buffer; mimeType: string; filename: string;
    caption?: string; parseMode?: "HTML" | "Markdown" | "MarkdownV2";
    replyMarkup?: unknown; protectContent?: boolean;
  }): Promise<void> {
    const form = new FormData();
    form.append("chat_id", opts.chatId);
    if (opts.caption) form.append("caption", opts.caption);
    form.append("parse_mode", opts.parseMode ?? "HTML");
    if (opts.replyMarkup) form.append("reply_markup", JSON.stringify(opts.replyMarkup));
    form.append("protect_content", String(opts.protectContent ?? false));
    // Uint8Array.from (não o Buffer direto): @types/node tipa Buffer como
    // Uint8Array<ArrayBufferLike> (aceita SharedArrayBuffer), e BlobPart exige
    // um ArrayBuffer concreto — Buffer cru não bate com o tipo, mesmo sendo
    // válido em runtime.
    form.append("photo", new Blob([Uint8Array.from(opts.buffer)], { type: opts.mimeType }), opts.filename);
    await this.callMultipart("sendPhoto", form);
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
      // Leitura pura — repetir não duplica nada. Idempotente.
      return await this.call("getChat", { chat_id: chatId }, { idempotent: true }) as { id: number; type: string; title?: string };
    } catch {
      return null;
    }
  }

  // Indicador de "digitando…"/"gravando áudio…" etc. Best-effort (não lança).
  // Repetir só reexibe o indicador — sem efeito duplicado. Idempotente.
  async sendChatAction(chatId: string, action: string): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action }, { idempotent: true }).catch(() => {});
  }

  // Responde o toast/loading do botão clicado — repetir não reenvia nada ao
  // chat, só reconfirma o callback. Idempotente.
  async answerCallbackQuery(opts: AnswerCallbackOptions): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: opts.callbackQueryId,
      text:              opts.text,
    }, { idempotent: true });
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

  // Substitui o teclado por completo (não incrementa nada) — repetir a mesma
  // chamada resulta no mesmo estado final. Idempotente.
  async editMessageReplyMarkup(chatId: string, messageId: number, replyMarkup: unknown): Promise<void> {
    await this.call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId, reply_markup: replyMarkup,
    }, { idempotent: true }).catch(() => {});
  }

  // Apagar uma mensagem já apagada só falha (best-effort, já engolido abaixo)
  // — sem efeito duplicado. Idempotente.
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, { idempotent: true }).catch(() => {});
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

  // Remove um membro do grupo por vencimento de acesso VIP (ver
  // expireDueVipMemberships em vip-membership.ts). `revoke_messages` não é
  // usado — expirar acesso não deve apagar as mensagens que o membro mandou.
  async banChatMember(chatId: string, userId: string): Promise<void> {
    await this.call("banChatMember", { chat_id: chatId, user_id: Number(userId) });
  }

  // Desbane logo em seguida do ban acima: sem isso o ban do Telegram é
  // permanente e o membro não conseguiria voltar a entrar numa renovação
  // futura, mesmo com um novo convite.
  async unbanChatMember(chatId: string, userId: string): Promise<void> {
    await this.call("unbanChatMember", { chat_id: chatId, user_id: Number(userId), only_if_banned: true });
  }
}
