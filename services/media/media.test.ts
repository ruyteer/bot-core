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
  const HTML_HEADER = Buffer.from("<!doctype html>\n<html><head></head></html>");
  const SVG_HEADER  = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');

  // WebM (gravação de microfone do navegador, Opus em WebM) — mesmo header
  // EBML do vídeo, sem indicar codec/track algum (não dá pra saber só pelos
  // bytes iniciais se carrega vídeo, áudio ou os dois).
  const EBML_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88]);
  // Ogg com track Theora (video/ogg) — mesmo cabeçalho "OggS" do Ogg Vorbis/Opus.
  const OGGS_HEADER = Buffer.from("OggS" + "\x00".repeat(10));
  // HEIC/AVIF usam a mesma caixa ISO-BMFF `ftyp` do MP4, só o major brand muda.
  const HEIC_HEADER = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(4)]);
  // QuickTime antigo (.mov) sem caixa `ftyp`: primeiro átomo já é `moov`.
  const MOOV_HEADER = Buffer.concat([Buffer.from([0, 0, 0, 0x08]), Buffer.from("moov")]);
  // MP3 sem tag ID3, frame sync fora dos 3 valores antigos cobertos (FF FB/F3/F2).
  const MP3_NO_ID3_ALT_SYNC = Buffer.from([0xff, 0xfa, 0x90, 0x00]);
  // AAC "cru" (ADTS) — mesmo padrão de sync word do MP3 (FF seguido de 3 bits em 1).
  const AAC_ADTS_HEADER = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]);

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

  // Regressão: containers "guarda-chuva" (EBML/OggS/ftyp) usados por mais de
  // uma categoria de mídia de verdade não podiam ser rejeitados só porque a
  // 1ª versão da assinatura só cobria uma categoria por container.
  describe("containers ambíguos — válidos em qualquer categoria de mídia que os usa de verdade", () => {
    it("audio/webm (gravação de microfone do navegador, Opus em WebM) é aceito — mesmo header EBML do vídeo", () => {
      expect(matchesFileSignature("audio/webm", EBML_HEADER)).toBe(true);
      expect(matchesFileSignature("video/webm", EBML_HEADER)).toBe(true);
    });

    it("video/ogg (Theora) é aceito — mesmo cabeçalho OggS do Ogg Vorbis/Opus", () => {
      expect(matchesFileSignature("video/ogg", OGGS_HEADER)).toBe(true);
      expect(matchesFileSignature("audio/ogg", OGGS_HEADER)).toBe(true);
    });

    it("image/heic e image/avif são aceitos — usam a mesma caixa ftyp (ISO-BMFF) do MP4", () => {
      expect(matchesFileSignature("image/heic", HEIC_HEADER)).toBe(true);
      expect(matchesFileSignature("image/avif", HEIC_HEADER)).toBe(true);
    });

    it("audio/mp4 (m4a) continua aceito com o mesmo container ftyp", () => {
      expect(matchesFileSignature("audio/mp4", MP4_HEADER)).toBe(true);
    });
  });

  it("video/quicktime antigo sem caixa ftyp (átomo moov direto) é aceito", () => {
    expect(matchesFileSignature("video/quicktime", MOOV_HEADER)).toBe(true);
  });

  describe("MP3 sem ID3 (qualquer frame sync MPEG) e AAC ADTS cru", () => {
    it("aceita frame sync MP3 fora dos 3 valores antigos (FF FB/F3/F2)", () => {
      expect(matchesFileSignature("audio/mpeg", MP3_NO_ID3_ALT_SYNC)).toBe(true);
    });

    it("aceita AAC ADTS (audio/aac) — mesmo padrão de sync word do MP3", () => {
      expect(matchesFileSignature("audio/aac", AAC_ADTS_HEADER)).toBe(true);
    });
  });

  describe("continuam rejeitados: executável e HTML disfarçados de mídia, e SVG", () => {
    it("MZ (executável Windows) declarado como vídeo ou áudio", () => {
      expect(matchesFileSignature("video/mp4", EXE_HEADER)).toBe(false);
      expect(matchesFileSignature("audio/mpeg", EXE_HEADER)).toBe(false);
    });

    it("HTML declarado como imagem, vídeo ou áudio", () => {
      expect(matchesFileSignature("image/png", HTML_HEADER)).toBe(false);
      expect(matchesFileSignature("video/mp4", HTML_HEADER)).toBe(false);
      expect(matchesFileSignature("audio/mpeg", HTML_HEADER)).toBe(false);
    });

    // SVG é texto (XML), sem assinatura binária — a checagem trata
    // "image/*" como categoria "image" (só assinaturas binárias), então SVG
    // nunca bate com nenhuma e é rejeitado. Não achei nenhum fluxo na UI
    // antiga que dependa de upload de SVG (accept="image/*" nos componentes
    // de mídia é genérico, não há tela dedicada a ícone/SVG); se isso for
    // usado em produção hoje, sinalizar antes de manter a rejeição.
    it("SVG declarado como image/svg+xml é rejeitado (sem assinatura binária reconhecida)", () => {
      expect(matchesFileSignature("image/svg+xml", SVG_HEADER)).toBe(false);
    });
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
