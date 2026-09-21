import { describe, it, expect } from "vitest";
import { replacePixVariables, fmtBRL } from "./pix-messages.js";
import { replaceOrderBumpVars } from "./order-bump.js";

describe("replacePixVariables", () => {
  it("substitui {nome} {valor} {produto} sem case-sensitive", async () => {
    const out = replacePixVariables("Oi {nome} — {VALOR} do {Produto}", {
      nome: "Ana", valor: "R$ 19,90", produto: "Curso",
    });
    expect(out).toBe("Oi Ana — R$ 19,90 do Curso");
  });

  it("token ausente vira string vazia, não o placeholder", () => {
    expect(replacePixVariables("{descricao}x", {})).toBe("x");
  });
});

describe("fmtBRL", () => {
  it("formata reais em pt-BR", () => {
    expect(fmtBRL(19.9)).toMatch(/R\$\s*19,90/);
  });
});

describe("replaceOrderBumpVars", () => {
  it("{preco} e {valor} são o mesmo token", () => {
    expect(replaceOrderBumpVars("{nome} +{preco}/{valor}", { nome: "X", preco: "R$ 1,00" }))
      .toBe("X +R$ 1,00/R$ 1,00");
  });
});
