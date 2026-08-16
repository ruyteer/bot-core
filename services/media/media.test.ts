import { describe, it, expect } from "vitest";
import { isAllowedMime, sanitizeFolder, extFromFilename } from "./application/validation.js";

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
