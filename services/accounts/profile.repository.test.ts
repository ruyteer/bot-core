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
