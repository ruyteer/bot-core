import { describe, it, expect } from "vitest";
import { isAllowedMime, matchesFileSignature, sanitizeFolder, extFromFilename } from "./application/validation.js";

describe("isAllowedMime", () => {
  it("aceita image/video/audio por prefixo", () => {
    expect(isAllowedMime("image/png")).toBe(true);
    expect(isAllowedMime("video/mp4")).toBe(true);
    expect(isAllowedMime("audio/ogg")).toBe(true);
  });
  it("aceita pdf/doc/docx/txt", () => {
    expect(isAllowedMime("application/pdf")).toBe(true);
    expect(isAllowedMime("text/plain")).toBe(true);
  });
  it("rejeita tipos fora da lista", () => {
    expect(isAllowedMime("application/x-msdownload")).toBe(false);
    expect(isAllowedMime("text/html")).toBe(false);
  });
});

describe("matchesFileSignature", () => {
  const PNG_HEADER  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
  const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]);
  const PDF_HEADER  = Buffer.from("%PDF-1.7\n%âãÏÓ\n");
  const DOCX_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]); // OOXML/zip
  const DOC_HEADER  = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // OLE
  const MP4_HEADER  = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4)]);
  const MP3_HEADER  = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]); // ID3
  // Cabeçalho MZ de executável Windows — o caso real que motivou a checagem.
  const EXE_HEADER  = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

  it("aceita imagem cujos bytes batem com a assinatura declarada", () => {
    expect(matchesFileSignature("image/png", PNG_HEADER)).toBe(true);
    expect(matchesFileSignature("image/jpeg", JPEG_HEADER)).toBe(true);
  });

  it("aceita pdf/docx/doc/mp4/mp3 com a assinatura correspondente", () => {
    expect(matchesFileSignature("application/pdf", PDF_HEADER)).toBe(true);
    expect(matchesFileSignature("application/vnd.openxmlformats-officedocument.wordprocessingml.document", DOCX_HEADER)).toBe(true);
    expect(matchesFileSignature("application/msword", DOC_HEADER)).toBe(true);
    expect(matchesFileSignature("video/mp4", MP4_HEADER)).toBe(true);
    expect(matchesFileSignature("audio/mpeg", MP3_HEADER)).toBe(true);
  });

  it("aceita texto plano que parece texto de verdade", () => {
    expect(matchesFileSignature("text/plain", Buffer.from("linha 1\nlinha 2\ncom acentuação também"))).toBe(true);
  });

  it("rejeita quando o MIME declarado não bate com os bytes reais (executável disfarçado de imagem)", () => {
    expect(matchesFileSignature("image/png", EXE_HEADER)).toBe(false);
    expect(matchesFileSignature("image/jpeg", EXE_HEADER)).toBe(false);
  });

  it("rejeita categoria cruzada (pdf real declarado como imagem, e vice-versa)", () => {
    expect(matchesFileSignature("image/png", PDF_HEADER)).toBe(false);
    expect(matchesFileSignature("application/pdf", PNG_HEADER)).toBe(false);
  });

  it("rejeita texto plano cujos bytes parecem binário (NUL byte)", () => {
    expect(matchesFileSignature("text/plain", EXE_HEADER)).toBe(false);
  });

  it("mime fora do reconhecido (fora da allowlist) nunca bate", () => {
    expect(matchesFileSignature("application/x-msdownload", EXE_HEADER)).toBe(false);
  });
});

describe("sanitizeFolder", () => {
  it("mantém caminho normal intacto", () => {
    expect(sanitizeFolder("botId/welcome")).toBe("botId/welcome");
  });
  it("remove pontos (mata '..') e barras nas pontas", () => {
    // "/" continua permitido (é assim que se monta um path aninhado, tipo
    // "botId/welcome") — o que importa é que ".." nunca sobrevive.
    expect(sanitizeFolder("../../etc/passwd")).toBe("etc/passwd");
    expect(sanitizeFolder("../../etc/passwd")).not.toContain("..");
    expect(sanitizeFolder("/broadcast/")).toBe("broadcast");
  });
  it("string vazia vira 'misc'", () => {
    expect(sanitizeFolder("")).toBe("misc");
  });
});

describe("extFromFilename", () => {
  it("extrai extensão em minúsculo", () => {
    expect(extFromFilename("foto.PNG")).toBe("png");
    expect(extFromFilename("video.mp4")).toBe("mp4");
  });
  it("sem extensão reconhecível cai em 'bin'", () => {
    expect(extFromFilename("semextensao")).toBe("bin");
  });
});
