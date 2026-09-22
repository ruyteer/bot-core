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
import { ProfileDrizzleRepository } from "./infrastructure/profile.drizzle.repository.js";
import { ProvisionProfileUseCase } from "./application/use-cases/provision-profile.use-case.js";
import { testDb } from "../../test/helpers/db.js";
import { __setTestDb } from "../shared/database.js";
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

  it("prioriza full_name sobre name, igual ao authHandler (ver auth.handler.ts)", () => {
    const input = parseProvisionClaims({
      sub: crypto.randomUUID(),
      email: "a@a.com",
      user_metadata: { name: "Nome Curto", full_name: "Nome Completo" },
      exp: baseExp,
    });
    expect(input.name).toBe("Nome Completo");
  });

  it("usa name quando full_name não vier", () => {
    const input = parseProvisionClaims({
      sub: crypto.randomUUID(),
      email: "a@a.com",
      user_metadata: { name: "Só Name" },
      exp: baseExp,
    });
    expect(input.name).toBe("Só Name");
  });
});

// ─── Endpoint completo (Header → verificação → claims → repositório) ──────────

let issuerSeq = 0;

/**
 * Assina um token e chama o endpoint `provision` de ponta a ponta, com um
 * emissor/JWKS de teste único por chamada (evita colidir com o cache de
 * `jwksByUrl` de auth.handler.ts entre chamadas). `aud` é PROVISION_AUDIENCE
 * por padrão; testes de audience errada passam outro valor de propósito.
 * `includeExp` (default true) controla se o token leva o claim `exp` — o
 * endpoint exige vida curta, então o teste de "sem exp" passa `false`.
 */
async function callProvision(opts: { sub: string; email?: string; name?: string; aud?: string; includeExp?: boolean }) {
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
    let builder = new SignJWT({
      email: opts.email ?? "user@example.com",
      user_metadata: { name: opts.name ?? "Fulano" },
    })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject(opts.sub)
      .setIssuer(nextIssuer)
      .setAudience(opts.aud ?? PROVISION_AUDIENCE)
      .setIssuedAt();
    if (opts.includeExp ?? true) builder = builder.setExpirationTime("5m");
    const token = await builder.sign(privateKey);

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

  it("rejeita token sem claim exp — o endpoint exige vida curta (jose só valida expiração quando exp está presente)", async () => {
    await expect(callProvision({ sub: crypto.randomUUID(), includeExp: false }))
      .rejects.toMatchObject({ code: "unauthenticated" });

    const db = await testDb();
    expect((await db.select().from(profiles)).length).toBe(0);
  });
});

// ─── Corrida simulada no INSERT (força o 23505, sem depender de concorrência
// real do PGlite — mesma técnica de services/referrals/referrals.test.ts:
// "catch do 23505 traduz a violação do índice único... força o INSERT a
// colidir, sem depender de concorrência real do PGlite") ────────────────────
//
// PGlite roda numa conexão única: `db.transaction()` serializa completamente,
// então duas chamadas de `provisionProfile.execute` via Promise.allSettled não
// reproduzem a corrida de verdade — a pré-checagem da 2ª chamada já enxergaria
// o que a 1ª gravou. Para exercitar de fato o catch de unique_violation
// (services/accounts/infrastructure/profile.drizzle.repository.ts#provision),
// troca-se `db.transaction` por uma versão cujo INSERT (dentro do savepoint)
// simula outra transação "vencendo a corrida": insere de verdade a linha
// concorrente e então lança o 23505 real do Postgres — o SELECT de
// releitura continua rodando contra o PGlite de verdade.
describe("ProfileDrizzleRepository.provision — corrida (simulada) resolvida sem 500 cru", () => {
  const repo             = new ProfileDrizzleRepository();
  const provisionProfile = new ProvisionProfileUseCase(repo);

  it("mesmo sub, e-mails diferentes: o INSERT simulado colide com a PK (profiles_pkey) e a releitura resolve para 'exists'", async () => {
    const realDb = await testDb();
    const sub = crypto.randomUUID();

    const fakeTx = {
      execute: async () => undefined, // advisory lock — no-op basta pro teste
      select:  realDb.select.bind(realDb),
      transaction: async () => {
        // Simula a OUTRA transação vencendo a corrida: insere de verdade o
        // mesmo sub, com um e-mail diferente do que esta chamada está usando.
        await realDb.insert(profiles).values({ id: sub, email: "ganhou-a-corrida@exemplo.com", name: "Ganhou a Corrida" });
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "profiles_pkey"'),
          { code: "23505", constraint: "profiles_pkey" },
        );
      },
    };
    const fakeDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "transaction") return async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx);
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    __setTestDb(fakeDb as unknown as Parameters<typeof __setTestDb>[0]);
    try {
      const result = await provisionProfile.execute({ id: sub, email: "perdeu-a-corrida@exemplo.com", name: "Perdeu a Corrida" });
      expect(result).toEqual({ status: "exists" });
    } finally {
      __setTestDb(realDb as unknown as Parameters<typeof __setTestDb>[0]);
    }

    const rows = await realDb.select().from(profiles).where(eq(profiles.id, sub));
    expect(rows.length).toBe(1); // só a linha que "ganhou a corrida", nada duplicado
    expect(rows[0].email).toBe("ganhou-a-corrida@exemplo.com");
  });

  it("e-mail já usado por outro sub: o INSERT simulado colide com profiles_email_lower_unique e a releitura resolve para 'email_taken'", async () => {
    const realDb = await testDb();
    const donoOriginal = crypto.randomUUID();
    const novoSub = crypto.randomUUID();

    const fakeTx = {
      execute: async () => undefined,
      select:  realDb.select.bind(realDb),
      transaction: async () => {
        // Simula a OUTRA transação vencendo a corrida: registra o dono do
        // e-mail disputado antes desta chamada tentar seu próprio INSERT.
        await realDb.insert(profiles).values({ id: donoOriginal, email: "disputado@exemplo.com", name: "Dono Original" });
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "profiles_email_lower_unique"'),
          { code: "23505", constraint: "profiles_email_lower_unique" },
        );
      },
    };
    const fakeDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "transaction") return async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx);
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    __setTestDb(fakeDb as unknown as Parameters<typeof __setTestDb>[0]);
    try {
      // O repositório espera email JÁ normalizado por quem chama (mesmo
      // contrato de ProvisionProfileInput — a normalização de caixa em si já
      // é coberta pelo teste de ponta a ponta "email_taken... com variação de
      // caixa" acima e por profile.repository.test.ts). Aqui o foco é só a
      // resolução da corrida via 23505.
      const result = await provisionProfile.execute({ id: novoSub, email: "disputado@exemplo.com", name: "Novo" });
      expect(result).toEqual({ status: "email_taken", userId: donoOriginal });
    } finally {
      __setTestDb(realDb as unknown as Parameters<typeof __setTestDb>[0]);
    }

    const rows = await realDb.select().from(profiles);
    expect(rows.length).toBe(1); // nada foi inserido pro novoSub
    expect(rows[0].id).toBe(donoOriginal);
  });

  it("unique_violation sem nenhum conflito visível na releitura propaga o erro original (não inventa um status)", async () => {
    const realDb = await testDb();
    const sub = crypto.randomUUID();

    const fakeTx = {
      execute: async () => undefined,
      select:  realDb.select.bind(realDb),
      transaction: async () => {
        // Simula um 23505 "fantasma": nenhuma linha concorrente é realmente
        // gravada, então a releitura não vai achar conflito nenhum.
        throw Object.assign(new Error('duplicate key value violates unique constraint "profiles_pkey"'), { code: "23505" });
      },
    };
    const fakeDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "transaction") return async (cb: (tx: typeof fakeTx) => unknown) => cb(fakeTx);
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    __setTestDb(fakeDb as unknown as Parameters<typeof __setTestDb>[0]);
    try {
      await expect(provisionProfile.execute({ id: sub, email: "sem-conflito@exemplo.com", name: "X" }))
        .rejects.toMatchObject({ code: "23505" });
    } finally {
      __setTestDb(realDb as unknown as Parameters<typeof __setTestDb>[0]);
    }
  });
});
