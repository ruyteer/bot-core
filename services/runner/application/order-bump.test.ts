import { describe, expect, it } from "vitest";
import { buildOrderBumpCard, replaceOrderBumpVars } from "./order-bump.js";

describe("replaceOrderBumpVars", () => {
  it("troca os aliases da UI antiga (bump_nome, bump_preco, total, produto)", () => {
    expect(
      replaceOrderBumpVars("{bump_nome} (+{bump_preco}) = {total} · {produto}", {
        nome: "Brinde",
        preco: "R$ 10,00",
        produto: "Curso",
        total: "R$ 29,90",
      }),
    ).toBe("Brinde (+R$ 10,00) = R$ 29,90 · Curso");
  });

  it("continua trocando {nome} e {preco|valor} da UI nova", () => {
    expect(replaceOrderBumpVars("✅ {nome} +{preco}", { nome: "X", preco: "R$ 1,00" })).toBe("✅ X +R$ 1,00");
    expect(replaceOrderBumpVars("{valor}", { preco: "R$ 2,00" })).toBe("R$ 2,00");
  });
});

describe("buildOrderBumpCard", () => {
  it("template legado {bump_nome} vira o nome no botão, não o placeholder", () => {
    const card = buildOrderBumpCard({
      items: [{ id: "0", name: "Brinde", price: 10 }],
      addOneTemplate: "{bump_nome} (+{bump_preco})",
      callbackYes: "ob:y:x:0",
      callbackNo: "ob:n:x:0",
      callbackOne: (id) => `ob:1:x:0:${id}`,
    });
    expect(card.replyMarkup.inline_keyboard[0][0].text).toMatch(/Brinde \(\+R\$\s*10,00\)/);
  });

  it("label vazio depois do replace não vai pro Telegram (BUTTON_TEXT_INVALID)", () => {
    const card = buildOrderBumpCard({
      items: [{ id: "0", name: "", price: 0 }],
      addOneTemplate: "{nome}",
      callbackYes: "ob:y:x:0",
      callbackNo: "ob:n:x:0",
      callbackOne: (id) => `ob:1:x:0:${id}`,
    });
    expect(String(card.replyMarkup.inline_keyboard[0][0].text).trim().length).toBeGreaterThan(0);
  });
});
