const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"];
const ALLOWED_MIME_EXACT = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p)) || ALLOWED_MIME_EXACT.has(mime);
}

// ─── Assinatura de bytes (magic numbers) ─────────────────────────────────────
//
// `isAllowedMime` só olha o Content-Type que o CLIENTE declarou no multipart —
// é confiança cega: um .exe/.html renomeado + Content-Type "image/png" passava
// direto pro storage e depois era servido de volta por GET /media/*key. Aqui
// confere se os bytes de verdade batem com a CATEGORIA do mime declarado
// antes de gravar; divergência = rejeita.
type SignatureCategory = "image" | "video" | "audio" | "document" | "text";

function startsWithBytes(buf: Buffer, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false;
  return true;
}

function asciiAt(buf: Buffer, offset: number, str: string): boolean {
  if (buf.length < offset + str.length) return false;
  return buf.toString("ascii", offset, offset + str.length) === str;
}

// Cada regra só confirma a CATEGORIA (não o subtipo exato) — o que importa é
// barrar a categoria errada (executável/script disfarçado), não fechar a
// lista exaustiva de todo container de vídeo/áudio existente.
const SIGNATURES: Array<{ category: SignatureCategory; test: (b: Buffer) => boolean }> = [
  // Imagens
  { category: "image", test: (b) => startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }, // PNG
  { category: "image", test: (b) => startsWithBytes(b, [0xff, 0xd8, 0xff]) }, // JPEG
  { category: "image", test: (b) => asciiAt(b, 0, "GIF87a") || asciiAt(b, 0, "GIF89a") }, // GIF
  { category: "image", test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP") }, // WEBP
  { category: "image", test: (b) => startsWithBytes(b, [0x42, 0x4d]) }, // BMP
  { category: "image", test: (b) => startsWithBytes(b, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(b, [0x4d, 0x4d, 0x00, 0x2a]) }, // TIFF

  // Vídeos
  { category: "video", test: (b) => asciiAt(b, 4, "ftyp") }, // MP4/MOV/M4V (ISO base media file format)
  { category: "video", test: (b) => startsWithBytes(b, [0x1a, 0x45, 0xdf, 0xa3]) }, // WEBM/MKV (EBML)
  { category: "video", test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "AVI ") }, // AVI
  { category: "video", test: (b) => startsWithBytes(b, [0x46, 0x4c, 0x56, 0x01]) }, // FLV

  // Áudios
  { category: "audio", test: (b) => asciiAt(b, 0, "ID3") }, // MP3 com tag ID3
  { category: "audio", test: (b) => startsWithBytes(b, [0xff, 0xfb]) || startsWithBytes(b, [0xff, 0xf3]) || startsWithBytes(b, [0xff, 0xf2]) }, // MP3 (frame sync sem ID3)
  { category: "audio", test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WAVE") }, // WAV
  { category: "audio", test: (b) => asciiAt(b, 0, "OggS") }, // OGG
  { category: "audio", test: (b) => asciiAt(b, 0, "fLaC") }, // FLAC
  { category: "audio", test: (b) => asciiAt(b, 4, "ftyp") }, // M4A/AAC (mesmo container do MP4)

  // Documentos
  { category: "document", test: (b) => startsWithBytes(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) }, // PDF (%PDF-)
  { category: "document", test: (b) => startsWithBytes(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) }, // .doc legado (OLE Compound File)
  { category: "document", test: (b) => startsWithBytes(b, [0x50, 0x4b, 0x03, 0x04]) }, // .docx (zip/OOXML)
];

function categoryOf(mime: string): SignatureCategory | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/pdf" ||
    mime === "application/msword" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) return "document";
  if (mime === "text/plain") return "text";
  return null;
}

// text/plain não tem assinatura binária — heurística: os primeiros bytes
// precisam parecer texto de verdade (sem NUL, sem excesso de bytes de
// controle). Não é prova formal, mas barra o caso comum de binário renomeado
// pra .txt.
function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.length === 0) return true;
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return false; // NUL não aparece em texto de verdade
    const isPrintableOrWhitespace = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127);
    if (!isPrintableOrWhitespace) controlBytes++;
  }
  return controlBytes / sample.length < 0.05;
}

/**
 * true = os bytes do arquivo condizem com a categoria do MIME declarado no
 * upload. Chamar só depois de `isAllowedMime` — aqui não se repete a
 * checagem de allowlist, só a de assinatura.
 */
export function matchesFileSignature(mime: string, buffer: Buffer): boolean {
  const category = categoryOf(mime);
  if (!category) return false;
  if (category === "text") return looksLikeText(buffer);
  return SIGNATURES.some((rule) => rule.category === category && rule.test(buffer));
}

// Só letras/números/traço/underscore/barra — sem ponto, então "../.." não
// sobrevive (bloqueia escapar do prefixo do usuário na chave do objeto).
export function sanitizeFolder(folder: string): string {
  const cleaned = folder.replace(/[^a-zA-Z0-9/_-]/g, "").replace(/^\/+|\/+$/g, "");
  return cleaned || "misc";
}

export function extFromFilename(filename: string): string {
  const m = /\.([a-zA-Z0-9]{1,10})$/.exec(filename);
  return (m?.[1] ?? "bin").toLowerCase();
}
