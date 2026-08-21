// Chamadas à Bot API usadas pela edição de perfil do bot e de grupos.
// Vive fora de `bots.api.ts` para ser testável: aquele arquivo importa
// `~encore/auth`, que não existe fora do runtime do Encore.

export interface TgResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

export async function tgCall(token: string, method: string, body?: Record<string, unknown>): Promise<TgResponse> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<TgResponse>;
}

// O Telegram responde HTTP 200 com {ok:false, description} em erro de negócio —
// um fetch que resolve. Quem só olha promise rejeitada (allSettled) nunca vê a
// falha e reporta sucesso ao usuário. Aqui ok:false vira throw.
export async function tgCallOrThrow(token: string, method: string, body?: Record<string, unknown>): Promise<TgResponse> {
  const r = await tgCall(token, method, body);
  if (!r.ok) throw new Error(`${method}: ${r.description || "erro desconhecido do Telegram"}`);
  return r;
}

// setMyProfilePhoto (Bot API 9.4) NÃO recebe o arquivo no campo `photo`: espera um
// InputProfilePhoto JSON-serializado que aponta pro arquivo via `attach://<nome>`,
// com o binário num campo separado do multipart. Mandar o blob direto em `photo`
// faz o Telegram recusar o upload.
export async function setProfilePhoto(token: string, photoBase64: string): Promise<void> {
  const buf  = Buffer.from(photoBase64, "base64");
  const form = new FormData();
  form.append("photo", JSON.stringify({ type: "static", photo: "attach://pic" }));
  form.append("pic", new Blob([buf], { type: "image/jpeg" }), "pic.jpg");

  const res  = await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, { method: "POST", body: form });
  const json = await res.json() as TgResponse;
  if (!json.ok) throw new Error(`setMyProfilePhoto: ${json.description || "erro desconhecido do Telegram"}`);
}

// setChatPhoto (grupos/canais) espera o binário direto no campo `photo` do
// multipart. Assim como setMyProfilePhoto, um fetch cru aqui resolve
// normalmente mesmo com {ok:false} (o Telegram responde HTTP 200 em erro de
// negócio) — precisa do mesmo check explícito que tgCallOrThrow faz, senão a
// falha nunca chega ao Promise.allSettled de quem chama.
export async function setChatPhoto(token: string, chatId: string, photoBase64: string): Promise<void> {
  const buf  = Buffer.from(photoBase64, "base64");
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([buf], { type: "image/jpeg" }), "photo.jpg");

  const res  = await fetch(`https://api.telegram.org/bot${token}/setChatPhoto`, { method: "POST", body: form });
  const json = await res.json() as TgResponse;
  if (!json.ok) throw new Error(`setChatPhoto: ${json.description || "erro desconhecido do Telegram"}`);
}
