import { describe, it, expect, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { isAllowedMime, matchesFileSignature, sanitizeFolder, extFromFilename } from "./application/validation.js";

// ─── GET /media/*key — nosniff, Content-Type e Content-Disposition ──────────
//
// Mocka o storage (s3-client) pra exercitar o handler getMedia sem rede real.
// api.raw devolve o handler puro em teste (ver test/stubs/encore-api.ts), então
// dá pra chamar getMedia(req, resp) direto com um par IncomingMessage/
// ServerResponse minimalista.
vi.mock("./application/s3-client.js", () => ({
  putObject: vi.fn(),
  getObject: vi.fn(),
}));

class FakeResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
    this.chunks.push(chunk);
    cb();
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function fakeRequest(pathAndQuery: string): { url: string } {
  return { url: pathAndQuery };
}

describe("GET /media/*key — headers de segurança", () => {
  it("resposta sempre inclui X-Content-Type-Options: nosniff", async () => {
    const { getMedia } = await import("./media.api.js");
    const s3 = await import("./application/s3-client.js");
    vi.mocked(s3.getObject).mockResolvedValue({
      body: Readable.from([Buffer.from("fake-png-bytes")]),
      contentType: "image/png",
      contentLength: 14,
    });

    const resp = new FakeResponse();
    await new Promise<void>((resolve) => {
      resp.on("finish", resolve);
      (getMedia as any)(fakeRequest("/media/u1/misc/foo.png"), resp);
    });

    expect(resp.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("documento (pdf) é servido com Content-Disposition: attachment", async () => {
    const { getMedia } = await import("./media.api.js");
    const s3 = await import("./application/s3-client.js");
    vi.mocked(s3.getObject).mockResolvedValue({
      body: Readable.from([Buffer.from("%PDF-1.7 fake")]),
      contentType: "application/pdf",
      contentLength: 13,
    });

    const resp = new FakeResponse();
    await new Promise<void>((resolve) => {
      resp.on("finish", resolve);
      (getMedia as any)(fakeRequest("/media/u1/misc/doc.pdf"), resp);
    });

    expect(resp.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(resp.headers["Content-Disposition"]).toMatch(/^attachment;/);
    expect(resp.headers["Content-Type"]).toBe("application/pdf");
  });

  it("imagem é servida com Content-Disposition: inline (preview no editor)", async () => {
    const { getMedia } = await import("./media.api.js");
    const s3 = await import("./application/s3-client.js");
    vi.mocked(s3.getObject).mockResolvedValue({
      body: Readable.from([Buffer.from("fake-png-bytes")]),
      contentType: "image/png",
      contentLength: 14,
    });

    const resp = new FakeResponse();
    await new Promise<void>((resolve) => {
      resp.on("finish", resolve);
      (getMedia as any)(fakeRequest("/media/u1/misc/foto.png"), resp);
    });

    expect(resp.headers["Content-Disposition"]).toMatch(/^inline;/);
  });

  it("Content-Disposition segue RFC 6266 — filename= ASCII-safe e filename*=UTF-8'' com o nome real", async () => {
    const { getMedia } = await import("./media.api.js");
    const s3 = await import("./application/s3-client.js");
    vi.mocked(s3.getObject).mockResolvedValue({
      body: Readable.from([Buffer.from("fake-png-bytes")]),
      contentType: "image/png",
      contentLength: 14,
    });

    const resp = new FakeResponse();
    await new Promise<void>((resolve) => {
      resp.on("finish", resolve);
      // Nome com espaço, parênteses, acento e aspas — a chave normal do
      // upload nunca tem isso (é sempre <uuid>.<ext>), mas o header não pode
      // quebrar nem virar um jeito de injetar algo na resposta se um dia isso
      // mudar.
      (getMedia as any)(fakeRequest('/media/u1/misc/relatório (final)".png'), resp);
    });

    const header = resp.headers["Content-Disposition"];
    expect(header).toMatch(/^inline; filename="[^"]*"; filename\*=UTF-8''/);
    // Aspas do nome original nunca terminam a quoted-string antes da hora.
    expect(header.match(/filename="([^"]*)"/)![1]).not.toContain('"');
    // filename* carrega o nome real, percent-encoded.
    expect(header).toContain(encodeURIComponent('relatório (final)".png').replace(/['()*]/g, (c: string) => "%" + c.charCodeAt(0).toString(16).toUpperCase()));
  });

  it("Content-Type divergente da allowlist do storage vira octet-stream (não confia cego no metadata)", async () => {
    const { getMedia } = await import("./media.api.js");
    const s3 = await import("./application/s3-client.js");
    // Cenário defensivo: metadata do objeto no storage viesse com um tipo fora
    // da allowlist (não devia acontecer via upload normal, mas o handler não
    // pode confiar cegamente nisso pra decidir o que manda de volta ao navegador).
    vi.mocked(s3.getObject).mockResolvedValue({
      body: Readable.from([Buffer.from("<script>alert(1)</script>")]),
      contentType: "text/html",
      contentLength: 26,
    });

    const resp = new FakeResponse();
    await new Promise<void>((resolve) => {
      resp.on("finish", resolve);
      (getMedia as any)(fakeRequest("/media/u1/misc/x"), resp);
    });

    expect(resp.headers["Content-Type"]).toBe("application/octet-stream");
    expect(resp.headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});

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
