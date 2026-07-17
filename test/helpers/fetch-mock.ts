// Mock de `global.fetch` para os testes: captura as chamadas à API do Telegram
// (para asserção do que o bot "envia") e responde os gateways PIX com payloads
// de sucesso no shape que cada client espera. Nenhuma rede real é tocada.

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

export interface CapturedFetch {
  url: string;
  body: Record<string, unknown> | null;
}

let telegramCalls: TelegramCall[] = [];
let otherCalls: CapturedFetch[] = [];
let originalFetch: typeof globalThis.fetch | undefined;

// Permite um teste forçar erro num método específico do Telegram (ex.: simular
// createChatInviteLink falhando) ou num gateway. errorCode opcional vira o
// `error_code` da resposta (ex.: 401 = token revogado).
const forcedErrors = new Map<string, number | undefined>();
export function forceTelegramError(method: string, errorCode?: number): void {
  forcedErrors.set(method, errorCode);
}

let pixSeq = 0;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function telegramResult(method: string, body: Record<string, unknown>): unknown {
  switch (method) {
    case "getMe":
      return { id: 123456, username: "testbot", first_name: "Test Bot", is_bot: true };
    case "setWebhook":
    case "deleteWebhook":
      return true;
    case "getChat":
      return { id: Number(body.chat_id), type: "supergroup", title: "Grupo de Teste" };
    case "createChatInviteLink":
      return { invite_link: "https://t.me/+testinvite" };
    case "sendChatAction":
    case "answerCallbackQuery":
    case "deleteMessage":
    case "editMessageReplyMarkup":
      return true;
    case "sendMediaGroup":
      // Um message por item, com file_id de photo/video (p/ o cache de mídia).
      return ((body.media as Array<{ type: string }>) ?? [{ type: "photo" }]).map((it) => ({
        message_id: ++pixSeq,
        ...(it.type === "video"
          ? { video: { file_id: `cached_video_${pixSeq}` } }
          : { photo: [{ file_id: `cached_photo_small_${pixSeq}` }, { file_id: `cached_photo_${pixSeq}` }] }),
      }));
    case "sendPhoto":
      return { message_id: ++pixSeq, chat: { id: body.chat_id }, photo: [{ file_id: `cached_photo_small_${pixSeq}` }, { file_id: `cached_photo_${pixSeq}` }] };
    case "sendVideo":
      return { message_id: ++pixSeq, chat: { id: body.chat_id }, video: { file_id: `cached_video_${pixSeq}` } };
    case "sendDocument":
      return { message_id: ++pixSeq, chat: { id: body.chat_id }, document: { file_id: `cached_document_${pixSeq}` } };
    case "sendAudio":
      return { message_id: ++pixSeq, chat: { id: body.chat_id }, audio: { file_id: `cached_audio_${pixSeq}` } };
    case "sendVoice":
      return { message_id: ++pixSeq, chat: { id: body.chat_id }, voice: { file_id: `cached_voice_${pixSeq}` } };
    default:
      // sendMessage
      return { message_id: ++pixSeq, chat: { id: body.chat_id } };
  }
}

function gatewayResponse(url: string): Response {
  const id = `ext_${++pixSeq}`;
  const code = `PIXCODE_${pixSeq}`;
  // SyncPay auth
  if (url.includes("/auth-token")) return jsonResponse({ access_token: "tok_test" });
  if (url.includes("syncpay") && url.includes("cash-in"))
    return jsonResponse({ pix_code: code, identifier: id });
  if (url.includes("realtechdev")) // BuckPay
    return jsonResponse({ data: { id, pix: { code, qrcode_base64: "x" } } });
  if (url.includes("nexuspag"))
    return jsonResponse({ pix_code: code, id });
  if (url.includes("wiinpay"))
    return jsonResponse({ pix_copy_paste: code, id });
  return jsonResponse({ ok: true });
}

export function installFetchMock(): void {
  if (!originalFetch) originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    let body: Record<string, unknown> | null = null;
    if (init?.body && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = null; }
    }

    // Telegram Bot API
    const tgMatch = url.match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    if (tgMatch) {
      const method = tgMatch[1];
      telegramCalls.push({ method, body: body ?? {} });
      if (forcedErrors.has(method)) {
        const code = forcedErrors.get(method);
        return jsonResponse({ ok: false, ...(code ? { error_code: code } : {}), description: "forced error" });
      }
      return jsonResponse({ ok: true, result: telegramResult(method, body ?? {}) });
    }

    // Gateways PIX
    if (/syncpay|realtechdev|nexuspag|wiinpay/.test(url)) {
      otherCalls.push({ url, body });
      if (forcedErrors.has(url)) return jsonResponse({ message: "forced error" }, 400);
      return gatewayResponse(url);
    }

    otherCalls.push({ url, body });
    return jsonResponse({ ok: true });
  }) as typeof globalThis.fetch;
}

export function resetFetchMock(): void {
  telegramCalls = [];
  otherCalls = [];
  forcedErrors.clear();
}

export function uninstallFetchMock(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}

// ── Asserção: helpers de leitura ───────────────────────────────────────────────

export function getTelegramCalls(method?: string): TelegramCall[] {
  return method ? telegramCalls.filter((c) => c.method === method) : telegramCalls;
}

export function getSentMessages(): string[] {
  return telegramCalls
    .filter((c) => c.method === "sendMessage")
    .map((c) => String(c.body.text ?? ""));
}

export function getSentPhotos(): TelegramCall[] {
  return telegramCalls.filter((c) => c.method === "sendPhoto");
}

export function lastTelegramCall(): TelegramCall | undefined {
  return telegramCalls[telegramCalls.length - 1];
}

export function getOtherCalls(): CapturedFetch[] {
  return otherCalls;
}
