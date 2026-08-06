// O painel insere variáveis com UMA chave ({nome}, {sobrenome}...) mas o
// interpolador só reconhecia {{var}} — o lead via "{nome}" literal na mensagem.
import { describe, it, expect } from "vitest";
import { interpolate, leadFieldsMap, mergeLeadFields } from "./interpolate.js";

const lead = { firstName: "João", lastName: "Silva", telegramUsername: "joaosilva" };

describe("interpolate — sintaxe de uma chave (a que o painel insere)", () => {
  it("{nome}, {sobrenome} e {username} são substituídos", () => {
    const vars = leadFieldsMap(lead);
    expect(interpolate("Oi {nome} {sobrenome} (@{username})!", vars))
      .toBe("Oi João Silva (@joaosilva)!");
  });

  it("{NOME} maiúsculo também funciona (case-insensitive)", () => {
    expect(interpolate("Oi {NOME}!", leadFieldsMap(lead))).toBe("Oi João!");
  });

  it("variável de uma chave DESCONHECIDA fica literal (protege {valor} do PIX)", () => {
    expect(interpolate("Total: {valor}", leadFieldsMap(lead))).toBe("Total: {valor}");
  });

  it("lead sem nome: {nome} some do texto (não fica literal)", () => {
    const vars = leadFieldsMap({ firstName: null, lastName: null, telegramUsername: null });
    expect(interpolate("Oi {nome}!", vars)).toBe("Oi !");
  });
});

describe("interpolate — sintaxe legada {{var}}", () => {
  it("{{first_name}} continua funcionando", () => {
    expect(interpolate("Oi {{first_name}}!", leadFieldsMap(lead))).toBe("Oi João!");
  });

  it("{{desconhecida}} continua virando vazio (compat)", () => {
    expect(interpolate("[{{x}}]", leadFieldsMap(lead))).toBe("[]");
  });
});

describe("mergeLeadFields — precedência", () => {
  it("lead_variable do usuário vence o campo nativo", () => {
    const vars = new Map([["nome", "Apelido"]]);
    mergeLeadFields(vars, lead);
    expect(interpolate("{nome} / {sobrenome}", vars)).toBe("Apelido / Silva");
  });
});
