import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import Busboy from "busboy";
import { encoreExternalUrl } from "../config/secrets.js";
import { isPlatformAdmin } from "../shared/roles.js";
import { putObject, getObject } from "./application/s3-client.js";
import { isAllowedMime, sanitizeFolder, extFromFilename } from "./application/validation.js";

// Espelha o limite que hoje só existe client-side (MediaUpload.tsx e afins,
// checado em bytes antes do upload) — agora também reforçado aqui, já que o
// backend passou a aceitar upload direto (antes o Supabase Storage era
// alcançado só pelo navegador, com o RLS dele como única barreira).
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

interface ParsedUpload {
  folder:   string;
  buffer:   Buffer;
  mime:     string;
  filename: string;
}

// Erro de validação do payload (400) — distinto de qualquer outra falha do
// parser (que vira um multipart inválido genérico).
class PayloadError extends Error {}

function parseMultipart(req: IncomingMessage, maxBytes: number): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    let folder = "";
    let fileFound = false;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    let mime = "";
    let filename = "";

    const bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } });

    bb.on("field", (name, value) => {
      if (name === "folder") folder = value;
    });

    bb.on("file", (_name, stream, info) => {
      fileFound = true;
      mime = info.mimeType;
      filename = info.filename;
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => { tooLarge = true; });
    });

    bb.on("error", (err) => reject(err));
    bb.on("close", () => {
      if (tooLarge) { reject(new PayloadError("arquivo excede o limite de 20MB")); return; }
      if (!fileFound) { reject(new PayloadError("nenhum arquivo enviado")); return; }
      resolve({ folder, buffer: Buffer.concat(chunks), mime, filename });
    });

    req.pipe(bb);
  });
}

export const uploadMedia = api.raw(
  { expose: true, method: "POST", path: "/media/upload", auth: true, bodyLimit: 25 * 1024 * 1024 },
  async (req, resp) => {
    const { userID: userId } = getAuthData()!;

    let parsed: ParsedUpload;
    try {
      parsed = await parseMultipart(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      const msg = err instanceof PayloadError ? err.message : "multipart inválido";
      resp.writeHead(400, { "Content-Type": "application/json" });
      resp.end(JSON.stringify({ error: msg }));
      return;
    }

    if (!isAllowedMime(parsed.mime)) {
      resp.writeHead(400, { "Content-Type": "application/json" });
      resp.end(JSON.stringify({ error: `tipo de arquivo não permitido: ${parsed.mime}` }));
      return;
    }

    const folder = sanitizeFolder(parsed.folder || "misc");
    if (folder.startsWith("notifications") && !(await isPlatformAdmin(userId))) {
      resp.writeHead(403, { "Content-Type": "application/json" });
      resp.end(JSON.stringify({ error: "apenas admin pode enviar para notifications" }));
      return;
    }

    const ext = extFromFilename(parsed.filename);
    const key = `${userId}/${folder}/${randomUUID()}.${ext}`;

    try {
      await putObject(key, parsed.buffer, parsed.mime);
    } catch (err) {
      console.error("[media] upload falhou:", err);
      resp.writeHead(502, { "Content-Type": "application/json" });
      resp.end(JSON.stringify({ error: "falha ao gravar no storage" }));
      return;
    }

    const url = `${encoreExternalUrl()}/media/${key}`;
    resp.writeHead(200, { "Content-Type": "application/json" });
    resp.end(JSON.stringify({ url }));
  },
);

// Público, sem auth — espelha a policy "public SELECT" que os buckets do
// Supabase tinham. É essa rota que o Telegram busca na primeira vez que um
// arquivo é mandado por URL (ver TelegramClient/media_cache), e que o
// navegador usa pra pré-visualizar mídia no editor de funil.
export const getMedia = api.raw(
  { expose: true, method: "GET", path: "/media/*key" },
  async (req, resp) => {
    const url = new URL(req.url ?? "/media/", "http://localhost");
    const key = decodeURIComponent(url.pathname.replace(/^\/media\//, ""));

    if (!key || key.includes("..")) {
      resp.writeHead(400, { "Content-Type": "text/plain" });
      resp.end("chave inválida");
      return;
    }

    const obj = await getObject(key);
    if (!obj) {
      resp.writeHead(404, { "Content-Type": "text/plain" });
      resp.end("não encontrado");
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type":  obj.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    if (obj.contentLength !== undefined) headers["Content-Length"] = String(obj.contentLength);

    resp.writeHead(200, headers);
    obj.body.pipe(resp);
  },
);
