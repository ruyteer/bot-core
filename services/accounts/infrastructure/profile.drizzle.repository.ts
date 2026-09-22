import { eq, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { profiles, userRoles } from "../../shared/schema/index.js";
import type { Profile, ProfileWithRoles, ProvisionProfileInput, ProvisionProfileResult, UpsertProfileInput } from "../domain/profile.entity.js";
import type { ProfileRepository } from "../domain/profile.repository.js";

export class ProfileDrizzleRepository implements ProfileRepository {
  // `name` só entra no INSERT (provisiona o nome do cadastro do Supabase na
  // primeira vez que o usuário aparece). NÃO entra no `set` do conflito: este
  // upsert roda no auth handler, em TODA requisição autenticada, com o nome
  // vindo do `user_metadata` do JWT — que nunca muda depois do signup. Se
  // `name` estivesse no `set`, qualquer troca de nome via PATCH /auth/profile
  // era revertida de volta pro nome original do JWT na request seguinte
  // (inclusive o próprio refetch de ["auth-me"] disparado pela invalidação
  // depois do PATCH) — o usuário via "Perfil atualizado" mas o nome nunca
  // ficava, silenciosamente.
  async upsert(input: UpsertProfileInput): Promise<Profile> {
    const [row] = await db
      .insert(profiles)
      .values({
        id:    input.id,
        email: input.email,
        name:  input.name,
      })
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          email:     input.email,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  // Provisionamento vindo do cadastro na UI nova (POST /accounts/provision).
  // Diferente do upsert acima (que roda em toda requisição autenticada e é
  // "confiante" quanto a colisão de e-mail), aqui é a PRIMEIRA gravação do
  // usuário — precisa impedir duas contas com o mesmo e-mail, e profiles.email
  // não tem unique constraint no schema. O advisory lock por e-mail normalizado
  // serializa provisionamentos concorrentes do mesmo e-mail dentro da transação
  // (liberado sozinho no commit/rollback — mesmo padrão de BotDrizzleRepository.create).
  async provision(input: ProvisionProfileInput): Promise<ProvisionProfileResult> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('profile-email:' || lower(${input.email})))`);

      const [emailOwner] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(sql`lower(${profiles.email}) = ${input.email}`)
        .limit(1);

      if (emailOwner && emailOwner.id !== input.id) {
        return { status: "email_taken", userId: emailOwner.id };
      }

      const [existing] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, input.id))
        .limit(1);

      if (existing) {
        // Idempotente: reenviar o mesmo sub não sobrescreve nada, mesmo que
        // email/name tenham vindo diferentes desta vez (ver decisão no PR).
        return { status: "exists" };
      }

      await tx.insert(profiles).values({
        id:    input.id,
        email: input.email,
        name:  input.name,
      });

      return { status: "created" };
    });
  }

  async findById(id: string): Promise<ProfileWithRoles | null> {
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, id))
      .limit(1);

    if (!profile) return null;

    const roles = await db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, id));

    const roleList = roles.map((r) => r.role);
    return {
      ...profile,
      roles:   roleList,
      isAdmin: roleList.includes("admin"),
    };
  }
}
