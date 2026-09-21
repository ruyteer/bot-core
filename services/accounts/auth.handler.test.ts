// Testes do handler de auth (services/accounts/auth.handler.ts): depois da
// virada só o JWT ES256 do app novo é aceito. JWT do Supabase (UI antiga)
// passa a ser `unknown token issuer`.
//
// Sem rede: cada teste gera seu próprio par de chaves ES256 com `jose` e
// injeta um `fetchImpl` que serve o JWKS em memória. URLs de emissor são
// únicas por teste porque `verifyAuthToken` cacheia um `createRemoteJWKSet`
// por URL; reusar a mesma URL entre testes com chaves diferentes reaproveitaria
// o cache do primeiro.
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

describe("verifyAuthToken — só o emissor do app novo (pós-virada)", () => {
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

    const config: AuthIssuersConfig = { nextAuthIssuer: nextIssuer, fetchImpl };
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

    const config: AuthIssuersConfig = { nextAuthIssuer: "https://next-iss-desconhecido.example" };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita token sem claim iss", async () => {
    const { privateKey } = await makeEs256Key("sem-iss");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "sem-iss" })
      .setSubject(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { nextAuthIssuer: undefined };
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

    const config: AuthIssuersConfig = { nextAuthIssuer: nextIssuer, fetchImpl };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita alg diferente de ES256 no emissor novo (algorithms restringido no jwtVerify)", async () => {
    const nextIssuer = "https://next-alg-errado.example";
    const { jwks } = await makeEs256Key("next-alg-errado");
    const fetchImpl = fetchServing(`${nextIssuer}/.well-known/jwks.json`, jwks);

    const forgedSecret = new TextEncoder().encode("chave-hmac-fraca-de-teste-0000000000");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "next-alg-errado" })
      .setSubject(crypto.randomUUID())
      .setIssuer(nextIssuer)
      .setAudience("orionbot-core")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(forgedSecret);

    const config: AuthIssuersConfig = { nextAuthIssuer: nextIssuer, fetchImpl };
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

    const config: AuthIssuersConfig = { nextAuthIssuer: nextIssuer, fetchImpl };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita JWT do Supabase (emissor legado da UI antiga)", async () => {
    const supabaseUrl = "https://supa-legado.example";
    const { privateKey, jwks } = await makeEs256Key("supa-legado");
    const fetchImpl = fetchServing(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, jwks);

    const token = await new SignJWT({ email: "b@b.com", user_metadata: { full_name: "Ciclana" } })
      .setProtectedHeader({ alg: "ES256", kid: "supa-legado" })
      .setSubject(crypto.randomUUID())
      .setIssuer(supabaseUrl)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const config: AuthIssuersConfig = { nextAuthIssuer: "https://next-nao-usado.example", fetchImpl };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejeita token do emissor novo quando NEXT_AUTH_ISSUER ainda não está configurado", async () => {
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

    const config: AuthIssuersConfig = { nextAuthIssuer: undefined, fetchImpl };
    await expect(verifyAuthToken(token, config)).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
