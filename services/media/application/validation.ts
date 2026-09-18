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

// Frame sync MPEG genérico: FF seguido de um byte cujos 3 bits mais altos
// são 1 (11 bits de sync no total). Cobre MP3 sem tag ID3 em qualquer
// combinação de MPEG version/layer (não só FF FB/F3/F2) e também ADTS de AAC
// "cru" (audio/aac, FF F1/F9) — os dois usam o mesmo padrão de sync word.
function isMpegFrameSync(b: Buffer): boolean {
  return b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
}

// Containers "guarda-chuva" — o mesmo container de bytes serve pra mais de
// uma categoria de mídia dependendo do codec/track de dentro, e não dá pra
// distinguir sem decodificar de verdade:
//   - ftyp (ISO-BMFF): MP4/MOV/M4V/3GP (vídeo), M4A/AAC (áudio) e também
//     HEIC/HEIF/AVIF (imagem) — todos usam a mesma caixa `ftyp` no offset 4.
//   - EBML: WebM pode carregar só vídeo, só áudio (ex.: gravação de
//     microfone do navegador em Opus/WebM, audio/webm) ou os dois; MKV é o
//     mesmo container.
//   - OggS: Ogg pode carregar Vorbis/Opus (áudio) ou Theora (video/ogg).
// Aceita esses containers pra qualquer categoria de mídia que os usa de
// verdade em vez de tentar diferenciar por assinatura (exigiria ler o
// major brand / faixas internas) — o que importa aqui é barrar a categoria
// ERRADA (executável/script disfarçado), não fechar os codecs 1:1.
const isFtypBox = (b: Buffer) => asciiAt(b, 4, "ftyp");
const isEbmlHeader = (b: Buffer) => startsWithBytes(b, [0x1a, 0x45, 0xdf, 0xa3]);
const isOggsHeader = (b: Buffer) => asciiAt(b, 0, "OggS");

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
  { category: "image", test: isFtypBox }, // HEIC/HEIF/AVIF (ISO-BMFF)

  // Vídeos
  { category: "video", test: isFtypBox }, // MP4/MOV/M4V/3GP (ISO-BMFF)
  { category: "video", test: isEbmlHeader }, // WEBM/MKV
  { category: "video", test: isOggsHeader }, // Ogg Theora (video/ogg)
  { category: "video", test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "AVI ") }, // AVI
  { category: "video", test: (b) => startsWithBytes(b, [0x46, 0x4c, 0x56, 0x01]) }, // FLV
  // QuickTime antigo sem caixa `ftyp`: começa direto num átomo top-level.
  { category: "video", test: (b) => ["moov", "mdat", "wide", "free", "skip"].some((atom) => asciiAt(b, 4, atom)) },

  // Áudios
  { category: "audio", test: (b) => asciiAt(b, 0, "ID3") }, // MP3 com tag ID3
  { category: "audio", test: isMpegFrameSync }, // MP3 sem ID3 e AAC ADTS cru (mesmo sync word)
  { category: "audio", test: (b) => asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WAVE") }, // WAV
  { category: "audio", test: isOggsHeader }, // Ogg Vorbis/Opus
  { category: "audio", test: (b) => asciiAt(b, 0, "fLaC") }, // FLAC
  { category: "audio", test: isFtypBox }, // M4A/AAC (mesmo container do MP4)
  { category: "audio", test: isEbmlHeader }, // audio/webm — gravação de microfone do navegador (Opus em WebM)

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
