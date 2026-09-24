import { describe, it, expect } from "vitest";
import { replacePixVariables, fmtBRL, sendPixMessages } from "./pix-messages.js";
import { replaceOrderBumpVars } from "./order-bump.js";
import type { TelegramClient } from "./telegram.client.js";

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

// Achado 5 da auditoria do runner do flow (`{nome}`/`{produto}` sem escape de
// HTML nos templates customizados de PIX) é resolvido no PR #64, dentro de
// `replacePixVariables` (escapa cada valor ali, cobre TODOS os chamadores).
// `sendPixMessages` propositalmente NÃO escapa `pixVars` aqui — faria dobrar
// a entidade quando os dois PRs estiverem juntos ("A & B" → "A &amp;amp; B").
// O caption padrão do flow (sem template customizado) já escapava por conta
// própria e continua escapando — cobertura abaixo.
describe("sendPixMessages — caption padrão do flow escapa productName", () => {
  it("caption padrão (sem template customizado) do flow escapa productName", async () => {
    const calls: Array<{ method: string; opts: Record<string, unknown> }> = [];
    const tg = {
      sendPhoto: async (opts: Record<string, unknown>) => { calls.push({ method: "sendPhoto", opts }); },
      sendMessage: async (opts: Record<string, unknown>) => { calls.push({ method: "sendMessage", opts }); },
    } as unknown as TelegramClient;
    await sendPixMessages({
      tg, chatId: "1", pixCode: "PIX<>&", qrPhoto: "http://x",
      amountReais: 10, productName: "A & B", protect: false, fallback: "flow",
      payCfg: {},
    });
    const photo = calls.find((c) => c.method === "sendPhoto")!;
    expect(String(photo.opts.caption)).toContain("A &amp; B");
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
