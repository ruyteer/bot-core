import { eq, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import { db } from "../../shared/database.js";
import { profiles, userRoles } from "../../shared/schema/index.js";
import type { Profile, ProfileWithRoles, ProvisionProfileInput, ProvisionProfileResult, UpsertProfileInput } from "../domain/profile.entity.js";
import type { ProfileRepository } from "../domain/profile.repository.js";

// unique_violation do Postgres (ver migrations/0018_profiles_email_lower_unique.sql:
// índice profiles_email_lower_unique, e a PK profiles_pkey). Mesmo padrão de
// checagem de `.code`/`.cause` de services/shared/ensure-schema.ts#isConnectionError.
function isUniqueViolation(err: unknown): boolean {
  type PgLike = { code?: unknown; cause?: PgLike } | null | undefined;
  let e = err as PgLike;
  while (e) {
    if (e.code === "23505") return true;
    e = e.cause;
  }
  return false;
}

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
    try {
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
    } catch (err) {
      // profiles_email_lower_unique (migrations/0018): o conflito do upsert só
      // olha profiles.id — um sub NOVO (ou um e-mail atualizado no upsert de um
      // sub existente) pode esbarrar num e-mail que já pertence a OUTRO
      // perfil. Isso é legítimo (duas contas competindo pelo mesmo e-mail —
      // ex.: cadastro pelo caminho antigo do Supabase depois de já ter sido
      // provisionado pela UI nova com o mesmo e-mail), não um bug — loga e
      // devolve um erro de auth claro em vez de derrubar a request com 500 cru.
      if (isUniqueViolation(err)) {
        console.error("[accounts] upsert de profile rejeitado: e-mail já vinculado a outra conta", { id: input.id, err });
        throw APIError.permissionDenied("e-mail já vinculado a outra conta");
      }
      throw err;
    }
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

      // Reusado antes do INSERT (pré-checagem otimista) e depois de um
      // 23505 (resolve a corrida real). `profiles_email_lower_unique`
      // (migrations/0018) é o que torna este segundo lookup confiável mesmo
      // quando o conflito veio de fora do lock — ex. o caminho antigo do
      // authHandler (sem advisory lock nenhum) inserindo entre os dois passos.
      const findConflict = async (): Promise<ProvisionProfileResult | null> => {
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

        return null;
      };

      const preCheck = await findConflict();
      if (preCheck) return preCheck;

      try {
        // INSERT roda num savepoint próprio: se ele falhar por unique_violation
        // (23505), só o savepoint desfaz — a transação externa (com o advisory
        // lock ainda seguro) continua utilizável para reconsultar e resolver.
        // Sem o savepoint, um erro de statement deixa a transação inteira
        // "aborted" e qualquer SELECT seguinte falharia com 25P02.
        await tx.transaction(async (tx2) => {
          await tx2.insert(profiles).values({
            id:    input.id,
            email: input.email,
            name:  input.name,
          });
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;

        // Corrida real: outra transação inseriu entre a pré-checagem acima e
        // este INSERT — mesmo sub com e-mails diferentes (colide na PK) ou
        // e-mail levado por outra conta entre o pré-check e agora. Cobre
        // também o caminho antigo (authHandler/upsertProfile), que não
        // respeita este advisory lock. Resolve de novo em vez de propagar o
        // 23505 cru como 500.
        const conflict = await findConflict();
        if (conflict) return conflict;

        // Não deveria acontecer: unique_violation sem nenhum conflito visível
        // nesta releitura. Propaga — não temos como classificar em
        // created/exists/email_taken com segurança.
        throw err;
      }

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
