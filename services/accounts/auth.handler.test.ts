// Testes do handler de auth (services/accounts/auth.handler.ts): convivência
// entre o JWT legado do Supabase e o JWT ES256 próprio do app novo enquanto a
// autenticação migra pra fora do Supabase. `verifyAuthToken` é a função pura
// de escolha+verificação extraída do authHandler (casca fina em cima dela).
//
// Sem rede: cada teste gera seu próprio par de chaves ES256 com `jose` e
// injeta um `fetchImpl` que serve o JWKS em memória — nada bate em Supabase
// nem no app novo de verdade. URLs de emissor são únicas por teste porque
// `verifyAuthToken` cacheia um `createRemoteJWKSet` por URL (de propósito,
// pra não re-buscar o JWKS a cada request em produção); reusar a mesma URL
// entre testes com chaves diferentes reaproveitaria o cache do primeiro.
import { describe, it, expect } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { verifyAuthToken, type AuthIssuersConfig } from "./auth.handler.js";

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

describe("verifyAuthToken — convivência Supabase (legado) + emissor novo (ES256)", () => {
  it("aceita token válido do emissor novo (ES256, iss/aud corretos)", async () => {
    const nextIssuer = "https://next-valido.example";
    const { privateKey, jwks } = await makeEs256Key("next-valido");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({ email: "a@a.com", user_metadata: { name: "Fulano" } })
      .setProtectedHeader({ alg: "ES256", kid: "next-valido" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience("orionbot-core")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { supabaseUrl: "https://supa-nao-usado.example", nextAuthIssuer: nextIssuer, fetchImpl };
    const payload = await verifyAuthToken(token, config);

    expect(payload.email).toBe("a@a.com");
    expect(payload.user_metadata?.name).toBe("Fulano");
  });

  it("rejeita iss desconhecido — nunca cai num emissor default", async () => {
    const { privateKey } = await makeEs256Key("iss-desconhecido");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "iss-desconhecido" })
      .setSubject(crypto.randomUUID())
      .setIssuer("https://issuer-nao-cadastrado.example")
      .setAudience("orionbot-core")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { supabaseUrl: "https://supa-iss-desconhecido.example", nextAuthIssuer: "https://next-iss-desconhecido.example" };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita token sem claim iss (não confunde 'undefined === undefined' com emissor não configurado)", async () => {
    const { privateKey } = await makeEs256Key("sem-iss");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "sem-iss" })
      .setSubject(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { supabaseUrl: "https://supa-sem-iss.example", nextAuthIssuer: undefined };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita aud errado no emissor novo", async () => {
    const nextIssuer = "https://next-aud-errado.example";
    const { privateKey, jwks } = await makeEs256Key("next-aud-errado");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "next-aud-errado" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience("outro-publico")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { supabaseUrl: "https://supa-nao-usado.example", nextAuthIssuer: nextIssuer, fetchImpl };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita alg diferente de ES256 no emissor novo (algorithms restringido no jwtVerify)", async () => {
    const nextIssuer = "https://next-alg-errado.example";
    const { jwks } = await makeEs256Key("next-alg-errado");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    // Forja um token HS256 usando o mesmo kid do JWKS ES256 — sem restringir
    // `algorithms`, um atacante pode tentar confundir o verificador quanto ao
    // algoritmo esperado.
    const forgedSecret = new TextEncoder().encode("chave-hmac-fraca-de-teste-0000000000");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "next-alg-errado" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience("orionbot-core")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(forgedSecret);

    const config: AuthIssuersConfig = { supabaseUrl: "https://supa-nao-usado.example", nextAuthIssuer: nextIssuer, fetchImpl };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita token expirado do emissor novo", async () => {
    const nextIssuer = "https://next-expirado.example";
    const { privateKey, jwks } = await makeEs256Key("next-expirado");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "next-expirado" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience("orionbot-core")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    const config: AuthIssuersConfig = { supabaseUrl: "https://supa-nao-usado.example", nextAuthIssuer: nextIssuer, fetchImpl };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("caminho Supabase continua aceitando o que aceitava — mesmo JWKS, sem novas restrições de issuer/audience/alg", async () => {
    const supabaseUrl = "https://supa-ok.example";
    const { privateKey, jwks } = await makeEs256Key("supa-ok");
    const fetchImpl = fetchServing(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, jwks);

    // Token no shape real do Supabase: sem `aud` de app específico (o Supabase
    // usa "authenticated"), e o handler nunca validou issuer/audience aqui.
    const token = await new SignJWT({ email: "b@b.com", user_metadata: { full_name: "Ciclana" } })
      .setProtectedHeader({ alg: "ES256", kid: "supa-ok" })
      .setSubject(crypto.randomUUID())
      .setIssuer(supabaseUrl)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { supabaseUrl, nextAuthIssuer: "https://next-nao-usado.example", fetchImpl };
    const payload = await verifyAuthToken(token, config);

    expect(payload.email).toBe("b@b.com");
    expect(payload.user_metadata?.full_name).toBe("Ciclana");
  });

  it("caminho Supabase continua funcionando mesmo sem NEXT_AUTH_ISSUER configurado", async () => {
    const supabaseUrl = "https://supa-sem-next.example";
    const { privateKey, jwks } = await makeEs256Key("supa-sem-next");
    const fetchImpl = fetchServing(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({ email: "c@c.com" })
      .setProtectedHeader({ alg: "ES256", kid: "supa-sem-next" })
      .setSubject(crypto.randomUUID())
      .setIssuer(supabaseUrl)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { supabaseUrl, nextAuthIssuer: undefined, fetchImpl };
    const payload = await verifyAuthToken(token, config);

    expect(payload.email).toBe("c@c.com");
  });

  it("rejeita token do emissor novo quando NEXT_AUTH_ISSUER ainda não está configurado (não quebra, só recusa esse token)", async () => {
    const nextIssuer = "https://next-nao-configurado.example";
    const { privateKey, jwks } = await makeEs256Key("next-nao-configurado");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "next-nao-configurado" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience("orionbot-core")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { supabaseUrl: "https://supa-nao-usado-2.example", nextAuthIssuer: undefined, fetchImpl };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
