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
