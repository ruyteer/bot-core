// Bug real de produção: o auth handler (services/accounts/auth.handler.ts)
// chama upsertProfile.execute em TODA requisição autenticada, com `name`
// vindo do user_metadata do JWT do Supabase (nunca muda depois do signup).
// Isso revertia qualquer troca de nome feita via PATCH /auth/profile na
// request seguinte — inclusive o próprio refetch de ["auth-me"] disparado
// pela invalidação depois do PATCH bem-sucedido. Ver ProfileDrizzleRepository.upsert.
import { describe, it, expect } from "vitest";
import { testDb } from "../../test/helpers/db.js";
import { ProfileDrizzleRepository } from "./infrastructure/profile.drizzle.repository.js";
import { profiles } from "../shared/schema/index.js";
import { eq } from "drizzle-orm";

const repo = new ProfileDrizzleRepository();

describe("ProfileDrizzleRepository.upsert — não reverte nome customizado", () => {
  it("no primeiro upsert (novo usuário), grava o nome vindo do JWT", async () => {
    const id = crypto.randomUUID();
    const row = await repo.upsert({ id, email: "a@a.com", name: "Nome do Cadastro" });
    expect(row.name).toBe("Nome do Cadastro");
  });

  it("num upsert seguinte (usuário já existente), NÃO sobrescreve um nome já customizado", async () => {
    const id = crypto.randomUUID();
    await repo.upsert({ id, email: "a@a.com", name: "Nome do Cadastro" });

    // Simula o PATCH /auth/profile: troca o nome fora do upsert (é o que o
    // endpoint updateProfile faz de verdade).
    const db = await testDb();
    await db.update(profiles).set({ name: "Nome Customizado" }).where(eq(profiles.id, id));

    // Simula a próxima requisição autenticada: o auth handler roda de novo o
    // upsert, com o MESMO `name` antigo do JWT (que nunca mudou).
    const row = await repo.upsert({ id, email: "a@a.com", name: "Nome do Cadastro" });

    expect(row.name).toBe("Nome Customizado");
  });

  it("continua sincronizando email do JWT mesmo depois do nome ser customizado", async () => {
    const id = crypto.randomUUID();
    await repo.upsert({ id, email: "antigo@a.com", name: "Nome do Cadastro" });

    const db = await testDb();
    await db.update(profiles).set({ name: "Nome Customizado" }).where(eq(profiles.id, id));

    const row = await repo.upsert({ id, email: "novo@a.com", name: "Nome do Cadastro" });

    expect(row.name).toBe("Nome Customizado");
    expect(row.email).toBe("novo@a.com");
  });
});

// Segurança (revisão do PR #53, POST /accounts/provision): profiles.email
// ganhou um índice único case-insensitive (migrations/0018_profiles_email_
// lower_unique.sql). O caminho antigo (authHandler/upsertProfile, usado pelo
// JWT do Supabase até a virada) não tem nenhuma trava de aplicação por
// e-mail — sem tratar o 23505 aqui, um sub novo com e-mail já usado por outro
// perfil derrubaria a request com um 500 cru vindo direto do Postgres.
describe("ProfileDrizzleRepository.upsert — e-mail já vinculado a outra conta (23505 do índice único)", () => {
  it("sub NOVO com e-mail já usado por outro perfil: erro de auth claro, não 500 cru", async () => {
    const donoOriginal = crypto.randomUUID();
    await repo.upsert({ id: donoOriginal, email: "ocupado@a.com", name: "Dono Original" });

    const subNovo = crypto.randomUUID();
    await expect(repo.upsert({ id: subNovo, email: "ocupado@a.com", name: "Outro" }))
      .rejects.toMatchObject({ code: "permission_denied" });

    const db = await testDb();
    const rows = await db.select().from(profiles);
    expect(rows.length).toBe(1); // nada foi inserido pro subNovo
  });

  it("mesma checagem vale com variação de caixa no e-mail (índice é sobre lower(email))", async () => {
    const donoOriginal = crypto.randomUUID();
    await repo.upsert({ id: donoOriginal, email: "foo@bar.com", name: "Dono Original" });

    const subNovo = crypto.randomUUID();
    await expect(repo.upsert({ id: subNovo, email: "Foo@Bar.com", name: "Outro" }))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("upsert de um sub JÁ EXISTENTE com e-mail atualizado que colide com OUTRO perfil também é recusado", async () => {
    const donoOriginal = crypto.randomUUID();
    await repo.upsert({ id: donoOriginal, email: "ocupado2@a.com", name: "Dono Original" });

    const outroUsuario = crypto.randomUUID();
    await repo.upsert({ id: outroUsuario, email: "email-proprio@a.com", name: "Outro Usuário" });

    // O JWT do "outro usuário" agora traz um e-mail diferente (trocou de
    // e-mail no provedor de auth) que colide com o dono original.
    await expect(repo.upsert({ id: outroUsuario, email: "ocupado2@a.com", name: "Outro Usuário" }))
      .rejects.toMatchObject({ code: "permission_denied" });

    const db = await testDb();
    const [row] = await db.select().from(profiles).where(eq(profiles.id, outroUsuario));
    expect(row.email).toBe("email-proprio@a.com"); // não foi alterado pelo upsert que falhou
  });
});
