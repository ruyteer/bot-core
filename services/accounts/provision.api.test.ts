// Testes do endpoint POST /accounts/provision (services/accounts/provision.api.ts):
// provisiona a conta no core assim que o cadastro acontece na UI nova. Usa o
// MESMO emissor/JWKS do authHandler normal (NEXT_AUTH_ISSUER), mas com uma
// audience PRÓPRIA (PROVISION_AUDIENCE) — um token comum de API não deve
// servir aqui, e um token de provisionamento não deve servir no authHandler
// normal (proteção cruzada).
//
// Os testes de verificação do TOKEN (audience errada, expirado, assinatura
// inválida) chamam `verifyAuthToken` diretamente, no mesmo estilo de
// auth.handler.test.ts — sem rede, com `fetchImpl` injetado servindo o JWKS em
// memória. Os testes de CLAIMS chamam `parseProvisionClaims` diretamente. Os
// testes de REGRA DE NEGÓCIO (created/exists/email_taken) chamam o endpoint
// `provision` de ponta a ponta (Header -> verificação -> claims ->
// repositório) contra o PGlite de teste, substituindo temporariamente
// `globalThis.fetch` para servir o JWKS do emissor de teste (delegando pro
// mock de fetch já instalado pelo setup global no resto das URLs).
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { verifyAuthToken } from "./auth.handler.js";
import { provision, PROVISION_AUDIENCE } from "./provision.api.js";
import { parseProvisionClaims } from "./domain/provision-claims.js";
import { testDb } from "../../test/helpers/db.js";
import { profiles } from "../shared/schema/index.js";

async function makeEs256Key(kid: string): Promise<{ privateKey: CryptoKey; jwks: { keys: JWK[] } }> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "ES256";
  jwk.use = "sig";
  return { privateKey, jwks: { keys: [jwk] } };
}

function fetchServing(jwksUrl: string, jwks: unknown): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === jwksUrl) {
      return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("verifyAuthToken — audience de provisionamento (proteção cruzada)", () => {
  it("aceita token com aud=orionbot-core:provision quando verificado com PROVISION_AUDIENCE", async () => {
    const nextIssuer = "https://prov-ok.example";
    const { privateKey, jwks } = await makeEs256Key("prov-ok");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({ email: "a@a.com", user_metadata: { name: "Fulano" } })
      .setProtectedHeader({ alg: "ES256", kid: "prov-ok" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience(PROVISION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const payload = await verifyAuthToken(token, {
      supabaseUrl: "", nextAuthIssuer: nextIssuer, fetchImpl, audience: PROVISION_AUDIENCE,
    });
    expect(payload.email).toBe("a@a.com");
  });

  it("rejeita token com aud=orionbot-core (audience normal da API) no endpoint de provision", async () => {
    const nextIssuer = "https://prov-aud-normal.example";
    const { privateKey, jwks } = await makeEs256Key("prov-aud-normal");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "prov-aud-normal" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience("orionbot-core") // audience normal, não a de provisionamento
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyAuthToken(token, { supabaseUrl: "", nextAuthIssuer: nextIssuer, fetchImpl, audience: PROVISION_AUDIENCE }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita token com aud=orionbot-core:provision quando verificado com a audience DEFAULT do authHandler normal (proteção cruzada, vice-versa)", async () => {
    const nextIssuer = "https://prov-cruzado.example";
    const { privateKey, jwks } = await makeEs256Key("prov-cruzado");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "prov-cruzado" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience(PROVISION_AUDIENCE) // token de provisionamento
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    // Sem passar `audience` — é exatamente o que o authHandler normal faz.
    await expect(
      verifyAuthToken(token, { supabaseUrl: "", nextAuthIssuer: nextIssuer, fetchImpl }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita token expirado", async () => {
    const nextIssuer = "https://prov-expirado.example";
    const { privateKey, jwks } = await makeEs256Key("prov-expirado");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "prov-expirado" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience(PROVISION_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    await expect(
      verifyAuthToken(token, { supabaseUrl: "", nextAuthIssuer: nextIssuer, fetchImpl, audience: PROVISION_AUDIENCE }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita token com assinatura inválida (JWKS não corresponde à chave usada pra assinar)", async () => {
    const nextIssuer = "https://prov-assinatura-invalida.example";
    const { jwks } = await makeEs256Key("prov-assinatura-invalida"); // JWKS público servido
    const { privateKey: outraChave } = await generateKeyPair("ES256", { extractable: true }); // assina com outra chave
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "prov-assinatura-invalida" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience(PROVISION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(outraChave);

    await expect(
      verifyAuthToken(token, { supabaseUrl: "", nextAuthIssuer: nextIssuer, fetchImpl, audience: PROVISION_AUDIENCE }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("parseProvisionClaims", () => {
  const baseExp = Math.floor(Date.now() / 1000) + 300;

  it("normaliza email (trim + lowercase) e name (trim)", () => {
    const input = parseProvisionClaims({
      sub: crypto.randomUUID(),
      email: "  Foo@Bar.com  ",
      user_metadata: { name: "  Fulano de Tal  " },
      exp: baseExp,
    });
    expect(input.email).toBe("foo@bar.com");
    expect(input.name).toBe("Fulano de Tal");
  });

  it("rejeita sub que não é UUID válido", () => {
    expect(() => parseProvisionClaims({
      sub: "não-é-uuid", email: "a@a.com", user_metadata: { name: "Fulano" }, exp: baseExp,
    })).toThrow(/uuid/i);
  });

  it("rejeita email malformado", () => {
    expect(() => parseProvisionClaims({
      sub: crypto.randomUUID(), email: "não-é-email", user_metadata: { name: "Fulano" }, exp: baseExp,
    })).toThrow(/email/i);
  });

  it("rejeita name vazio", () => {
    expect(() => parseProvisionClaims({
      sub: crypto.randomUUID(), email: "a@a.com", user_metadata: { name: "   " }, exp: baseExp,
    })).toThrow(/name/i);
  });

  it("rejeita name maior que 120 caracteres", () => {
    expect(() => parseProvisionClaims({
      sub: crypto.randomUUID(), email: "a@a.com", user_metadata: { name: "x".repeat(121) }, exp: baseExp,
    })).toThrow(/name/i);
  });
});

// ─── Endpoint completo (Header → verificação → claims → repositório) ──────────

let issuerSeq = 0;

/**
 * Assina um token e chama o endpoint `provision` de ponta a ponta, com um
 * emissor/JWKS de teste único por chamada (evita colidir com o cache de
 * `jwksByUrl` de auth.handler.ts entre chamadas). `aud` é PROVISION_AUDIENCE
 * por padrão; testes de audience errada passam outro valor de propósito.
 */
async function callProvision(opts: { sub: string; email?: string; name?: string; aud?: string }) {
  const seq = ++issuerSeq;
  const nextIssuer = `https://prov-e2e-${seq}.example`;
  const kid = `prov-e2e-${seq}`;
  const jwksUrl = `${nextIssuer}/.well-known/jwks.json`;
  const { privateKey, jwks } = await makeEs256Key(kid);

  const previousFetch = globalThis.fetch;
  const previousIssuer = process.env.TEST_SECRET_NEXT_AUTH_ISSUER;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === jwksUrl) {
      return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
    }
    return previousFetch(input as never, init as never);
  }) as typeof fetch;
  process.env.TEST_SECRET_NEXT_AUTH_ISSUER = nextIssuer;

  try {
    const token = await new SignJWT({
      email: opts.email ?? "user@example.com",
      user_metadata: { name: opts.name ?? "Fulano" },
    })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject(opts.sub)
      .setIssuer(nextIssuer)
      .setAudience(opts.aud ?? PROVISION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    return await provision({ authorization: `Bearer ${token}` } as never);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousIssuer === undefined) delete process.env.TEST_SECRET_NEXT_AUTH_ISSUER;
    else process.env.TEST_SECRET_NEXT_AUTH_ISSUER = previousIssuer;
  }
}

describe("POST /accounts/provision — endpoint completo", () => {
  it("created: primeiro provisionamento de um sub/email novos", async () => {
    const sub = crypto.randomUUID();
    const result = await callProvision({ sub, email: "novo@exemplo.com", name: "Novo Usuário" });

    expect(result).toEqual({ status: "created" });

    const db = await testDb();
    const [row] = await db.select().from(profiles).where(eq(profiles.id, sub));
    expect(row.email).toBe("novo@exemplo.com");
    expect(row.name).toBe("Novo Usuário");
  });

  it("exists: reenviar o mesmo sub é idempotente e NÃO sobrescreve email/name, mesmo vindo diferente", async () => {
    const sub = crypto.randomUUID();
    await callProvision({ sub, email: "original@exemplo.com", name: "Nome Original" });

    const result = await callProvision({ sub, email: "outro@exemplo.com", name: "Outro Nome" });
    expect(result).toEqual({ status: "exists" });

    const db = await testDb();
    const [row] = await db.select().from(profiles).where(eq(profiles.id, sub));
    expect(row.email).toBe("original@exemplo.com");
    expect(row.name).toBe("Nome Original");
  });

  it("email_taken: e-mail já usado por outro sub (com variação de caixa) não é inserido e não altera o dono original", async () => {
    const donoOriginal = crypto.randomUUID();
    await callProvision({ sub: donoOriginal, email: "foo@bar.com", name: "Dono Original" });

    const novoSub = crypto.randomUUID();
    const result = await callProvision({ sub: novoSub, email: "Foo@Bar.com", name: "Outro" });

    expect(result).toEqual({ status: "email_taken", userId: donoOriginal });

    const db = await testDb();
    const rows = await db.select().from(profiles);
    expect(rows.length).toBe(1); // nada foi inserido pro novoSub
    expect(rows[0].id).toBe(donoOriginal);
    expect(rows[0].name).toBe("Dono Original");
  });

  it("rejeita token com audience normal (orionbot-core) — o endpoint só aceita PROVISION_AUDIENCE", async () => {
    await expect(callProvision({ sub: crypto.randomUUID(), aud: "orionbot-core" }))
      .rejects.toMatchObject({ code: "unauthenticated" });

    const db = await testDb();
    expect((await db.select().from(profiles)).length).toBe(0);
  });

  it("rejeita claims inválidas (sub não-UUID) mesmo com token/audience corretos", async () => {
    await expect(callProvision({ sub: "não-é-um-uuid" })).rejects.toMatchObject({ code: "invalid_argument" });

    const db = await testDb();
    expect((await db.select().from(profiles)).length).toBe(0);
  });
});
