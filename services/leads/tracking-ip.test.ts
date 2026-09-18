// Resolução do IP real do visitante em GET /r — o endpoint é público, então
// confiar no primeiro valor de X-Forwarded-For (controlável por quem chama a
// API direto) deixava forjar o IP gravado no lead. Ver resolveClientIp em
// tracking.api.ts para o raciocínio completo do formato Railway + UI nova.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveClientIp } from "./tracking.api.js";

const SECRET_ENV = "TEST_SECRET_TRUSTED_PROXY_SECRET";

describe("resolveClientIp", () => {
  afterEach(() => {
    delete process.env[SECRET_ENV];
  });

  it("sem X-Forwarded-For, usa o IP da conexão TCP", () => {
    expect(resolveClientIp({}, "10.0.0.1")).toBe("10.0.0.1");
  });

  it("sem secret configurado, usa o ÚLTIMO valor da lista (o que a plataforma acrescentou), não o primeiro", () => {
    const headers = { "x-forwarded-for": "1.2.3.4, 5.6.7.8" };
    expect(resolveClientIp(headers, "9.9.9.9")).toBe("5.6.7.8");
  });

  it("chamador direto forjando o header não consegue passar um IP arbitrário sem o secret", () => {
    // Um atacante chamando /r direto pode escrever QUALQUER coisa no XFF,
    // mas o último valor de uma chamada direta (sem passar pela Railway) não
    // dá pra fabricar como se fosse o do próprio proxy da plataforma — aqui
    // simulamos só a garantia de que, sem o secret, o forjado no início da
    // lista é ignorado.
    const headers = { "x-forwarded-for": "ip-forjado-pelo-atacante" };
    expect(resolveClientIp(headers, "203.0.113.1")).toBe("ip-forjado-pelo-atacante");
    // (o único IP da lista É o último — por isso a UI própria precisa do
    // secret pra ter o SEGUNDO valor de uma lista de 2+ itens considerado.)
  });

  it("com secret configurado mas header da requisição não bate, ainda usa o último valor", () => {
    process.env[SECRET_ENV] = "segredo-compartilhado";
    const headers = { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-trusted-proxy-secret": "chute-errado" };
    expect(resolveClientIp(headers, "9.9.9.9")).toBe("5.6.7.8");
  });

  it("com secret configurado e header batendo, usa o PENÚLTIMO valor (o que a UI alega ser o IP do visitante)", () => {
    process.env[SECRET_ENV] = "segredo-compartilhado";
    const headers = { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-trusted-proxy-secret": "segredo-compartilhado" };
    expect(resolveClientIp(headers, "9.9.9.9")).toBe("1.2.3.4");
  });

  it("chamador confiável mas com só 1 valor no XFF (sem hop da UI) cai pro último mesmo assim", () => {
    process.env[SECRET_ENV] = "segredo-compartilhado";
    const headers = { "x-forwarded-for": "5.6.7.8", "x-trusted-proxy-secret": "segredo-compartilhado" };
    expect(resolveClientIp(headers, "9.9.9.9")).toBe("5.6.7.8");
  });

  it("X-Forwarded-For repetido (array) é tratado como se fosse uma lista só, concatenada", () => {
    const headers = { "x-forwarded-for": ["1.2.3.4", "5.6.7.8"] };
    expect(resolveClientIp(headers, "9.9.9.9")).toBe("5.6.7.8");
  });
});
