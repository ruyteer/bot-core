import { sql, eq, and } from "drizzle-orm";
import { db } from "../../shared/database.js";
import { botGroups, bots, vipMembers } from "../../shared/schema/index.js";
import { decrypt } from "../../shared/crypto.js";
import { TelegramClient, TelegramApiError } from "./telegram.client.js";
import { sendPushToUser, PUSH_EVENT_TYPES } from "../../notifications/application/send-push.use-case.js";

// `bot_groups` não tem unicidade em (bot_id, telegram_chat_id) — nada impede
// duas linhas com o mesmo chat id (ex.: grupo recriado/reimportado). Resolver
// sempre a MAIS ANTIGA (created_at asc) torna a escolha determinística em vez
// de depender da ordem física do Postgres, que pode mudar entre execuções.
// Não criamos o índice único correspondente aqui — precisaria checar
// duplicatas em produção antes (ver relatório do PR).
async function resolveBotGroupByChatId(botId: string, telegramChatId: bigint): Promise<{ id: string } | undefined> {
  const [group] = await db.select({ id: botGroups.id }).from(botGroups)
    .where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, telegramChatId)))
    .orderBy(botGroups.createdAt)
    .limit(1);
  return group;
}

// ── Registro/renovação de assinatura VIP ────────────────────────────────────
// Achado crítico da auditoria: a entrega de convite de grupo VIP acontecia,
// mas ninguém gravava em `vip_members` quem entrou, em qual grupo, nem por
// quanto tempo — o acesso nunca expirava. Esta função é chamada nos 4 pontos
// de entrega de oferta `vip_group` (ver execute-flow-step.use-case.ts e
// execute-simplified-funnel.use-case.ts), sempre DEPOIS do convite ter sido
// gerado com sucesso.

export interface VipMembershipInput {
  botId: string;
  /** Chat id do GRUPO (telegram_group_id do node / vip_group_id do item, ou o
   *  telegram_chat_id já resolvido do catálogo de ofertas) — string, pode ser
   *  negativo. */
  groupTelegramChatId: string;
  /** Chat id do LEAD/comprador (identidade usada depois pra ban/unban). */
  memberTelegramChatId: bigint;
  username?:  string | null;
  firstName?: string | null;
  lastName?:  string | null;
  /** Dias de acesso da oferta. null/0/undefined = vitalício. */
  accessDays?: number | null;
  paymentId?: string | null;
  offerId?:   string | null;
}

/**
 * Registra ou renova a assinatura VIP de um lead num grupo. Upsert atômico em
 * (bot_id, group_id, telegram_chat_id): uma nova compra do mesmo lead no
 * mesmo grupo ESTENDE o acesso (soma ao vencimento atual se ainda ativo, ou
 * conta a partir de agora se já tinha expirado/nunca existiu) em vez de
 * duplicar a linha — e reativa (`is_blocked = false`) quem tinha sido banido
 * por vencimento. Vitalício (accessDays vazio/0) zera o vencimento mesmo se
 * havia um prazo anterior: a oferta paga agora manda.
 *
 * Não falha a entrega: se o chat id do convite não corresponde a nenhuma
 * linha em `bot_groups` (config órfã — grupo removido/editado depois que a
 * oferta foi criada), só loga e não registra nada. Sem o `group_id` interno
 * não há como saber, na hora de expirar, de qual grupo remover o membro — o
 * comprador já recebeu o convite normalmente, só não entra no controle de
 * expiração automática.
 */
export async function registerOrRenewVipMembership(input: VipMembershipInput): Promise<void> {
  let groupChatId: bigint;
  try {
    groupChatId = BigInt(input.groupTelegramChatId);
  } catch {
    console.warn(`[vip] chat id de grupo inválido "${input.groupTelegramChatId}" (bot=${input.botId}) — assinatura não registrada`);
    return;
  }

  const group = await resolveBotGroupByChatId(input.botId, groupChatId);
  if (!group) {
    console.warn(`[vip] grupo ${input.groupTelegramChatId} não encontrado em bot_groups (bot=${input.botId}) — acesso entregue mas assinatura não registrada (sem expiração automática)`);
    return;
  }

  const days = typeof input.accessDays === "number" && Number.isFinite(input.accessDays) && input.accessDays > 0
    ? Math.floor(input.accessDays)
    : null;

  await db.execute(sql`
    INSERT INTO vip_members (
      id, bot_id, group_id, telegram_chat_id, username, first_name, last_name,
      is_blocked, joined_at, access_days, expires_at, expired_at, expire_claimed_at,
      payment_id, offer_id, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${input.botId}, ${group.id}, ${input.memberTelegramChatId},
      ${input.username ?? null}, ${input.firstName ?? null}, ${input.lastName ?? null},
      false, now(), ${days},
      CASE WHEN ${days}::integer IS NULL THEN NULL ELSE now() + (${days}::integer * interval '1 day') END,
      NULL, NULL, ${input.paymentId ?? null}, ${input.offerId ?? null}, now(), now()
    )
    ON CONFLICT (bot_id, group_id, telegram_chat_id) WHERE group_id IS NOT NULL
    DO UPDATE SET
      username    = EXCLUDED.username,
      first_name  = EXCLUDED.first_name,
      last_name   = EXCLUDED.last_name,
      is_blocked  = false,
      -- Vitalício ATUAL (expires_at/expired_at nulos, nunca expirou) não pode
      -- ser rebaixado por uma entrega com prazo — sem isso, quem já tinha
      -- acesso vitalício e recebe outra entrega (ex.: bump, reenvio) ganhava
      -- um vencimento finito e era banido pelo job de expiração mais tarde.
      -- Vitalício NOVO (EXCLUDED.access_days IS NULL) sempre vence: a compra
      -- de agora manda.
      access_days = CASE
        WHEN EXCLUDED.access_days IS NULL THEN NULL
        WHEN vip_members.expires_at IS NULL AND vip_members.expired_at IS NULL THEN NULL
        ELSE EXCLUDED.access_days
      END,
      expires_at  = CASE
        WHEN EXCLUDED.access_days IS NULL THEN NULL
        WHEN vip_members.expires_at IS NULL AND vip_members.expired_at IS NULL THEN NULL
        WHEN vip_members.expires_at IS NOT NULL AND vip_members.expires_at > now() AND vip_members.expired_at IS NULL
          THEN vip_members.expires_at + (EXCLUDED.access_days * interval '1 day')
        ELSE now() + (EXCLUDED.access_days * interval '1 day')
      END,
      expired_at        = NULL,
      expire_claimed_at = NULL,
      payment_id        = EXCLUDED.payment_id,
      offer_id          = EXCLUDED.offer_id,
      updated_at        = now()
  `);
}

/**
 * Calcula o `expire_date` (epoch em segundos) que o convite do Telegram deve
 * usar — o MESMO vencimento final que `registerOrRenewVipMembership` vai
 * persistir (empilhado sobre uma assinatura ainda ativa, ou preservando
 * vitalício), não só os dias desta compra isolada. Sem isso, uma renovação
 * gerava um convite que expirava em `accessDays` a partir de agora, mas o
 * banco guardava o vencimento empilhado (mais longe) — o convite ficava
 * "errado" mesmo com o acesso real correto.
 *
 * É uma LEITURA (não atômica com o upsert que vem depois): compra
 * concorrente do mesmo lead no mesmo grupo entre o preview e o registro é uma
 * janela de corrida teórica e rara — na pior hipótese o convite reflete um
 * vencimento levemente desatualizado, o acesso registrado em `vip_members`
 * (a fonte da verdade) continua correto.
 *
 * Retorna `undefined` quando o convite não deve ter expiração (compra
 * vitalícia, ou assinatura atual já vitalícia e ainda não expirada).
 */
export async function previewVipInviteExpireEpoch(
  botId: string, groupTelegramChatId: string, memberTelegramChatId: bigint, accessDays: number | null | undefined,
): Promise<number | undefined> {
  const days = typeof accessDays === "number" && Number.isFinite(accessDays) && accessDays > 0
    ? Math.floor(accessDays)
    : null;
  if (days === null) return undefined; // esta compra é vitalícia

  let groupChatId: bigint;
  try {
    groupChatId = BigInt(groupTelegramChatId);
  } catch {
    return Math.floor(Date.now() / 1000) + days * 86400;
  }

  const group = await resolveBotGroupByChatId(botId, groupChatId);
  if (!group) return Math.floor(Date.now() / 1000) + days * 86400;

  const [existing] = await db.select({ expiresAt: vipMembers.expiresAt, expiredAt: vipMembers.expiredAt }).from(vipMembers)
    .where(and(eq(vipMembers.botId, botId), eq(vipMembers.groupId, group.id), eq(vipMembers.telegramChatId, memberTelegramChatId)));

  if (existing && existing.expiresAt === null && existing.expiredAt === null) return undefined; // vitalício preservado
  const activeBaseMs = existing?.expiresAt && !existing.expiredAt && existing.expiresAt.getTime() > Date.now()
    ? existing.expiresAt.getTime()
    : Date.now();
  return Math.floor((activeBaseMs + days * 86_400_000) / 1000);
}

// ── Expiração automática (chamado pelo tick lento do runner) ───────────────

const EXPIRE_BATCH = 40;

// Evita reavisar o dono a cada retry (o claim já espaça as tentativas em
// ~10min, mas um grupo sem o bot como admin por dias geraria dezenas de
// pushes iguais). Em memória — reseta a cada deploy/restart, o que é
// aceitável: o pior caso é avisar de novo depois de um restart, não deixar de
// avisar nunca. Mesmo padrão de cooldown em memória de `botRateLimitUntil` em
// runner.ts.
const notifiedGroupPermissionLoss = new Set<string>();

type ClaimedVipMember = {
  id:             string;
  botId:          string;
  groupId:        string;
  telegramChatId: bigint;
};

/**
 * Processa um lote de assinaturas VIP vencidas: bane e desbane o membro do
 * grupo (ban+unban em vez de só ban, pra ele poder voltar a entrar se comprar
 * de novo — kickChatMember teria o mesmo efeito, mas deixaria o chat_id
 * banido permanentemente) e marca `expired_at`/`is_blocked`.
 *
 * Claim atômico igual ao de `runDuePendingDelays` em runner.ts: UPDATE ...
 * WHERE ... FOR UPDATE SKIP LOCKED ... RETURNING, usando `expire_claimed_at`
 * como marcador de "peguei este item" (mesmo truque de `execute_at` nos
 * delays) — réplicas concorrentes do runner pegam lotes disjuntos, e um
 * processo que morre no meio (deploy, OOM) libera o claim depois de 10min
 * pro próximo tick tentar de novo, em vez de deixar o membro banido pra
 * sempre "processando".
 */
export async function expireDueVipMemberships(): Promise<number> {
  const claimed = await db.execute<ClaimedVipMember>(sql`
    UPDATE vip_members SET expire_claimed_at = now()
    WHERE id IN (
      SELECT id FROM vip_members
      WHERE expires_at IS NOT NULL AND expires_at <= now() AND expired_at IS NULL
        AND is_blocked = false
        AND (expire_claimed_at IS NULL OR expire_claimed_at < now() - interval '10 minutes')
      ORDER BY expires_at ASC
      LIMIT ${EXPIRE_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, bot_id AS "botId", group_id AS "groupId", telegram_chat_id AS "telegramChatId"
  `);
  const due = (claimed.rows ?? []) as ClaimedVipMember[];
  if (due.length === 0) return 0;

  let expired = 0;
  for (const member of due) {
    try {
      const [bot]   = await db.select().from(bots).where(eq(bots.id, member.botId));
      const [group] = await db.select().from(botGroups).where(eq(botGroups.id, member.groupId));
      if (!bot || !group) {
        // Bot ou grupo apagado depois da assinatura — nada a remover no
        // Telegram. Marca expirado mesmo assim: manter reprocessando pra
        // sempre não ajuda ninguém.
        await db.update(vipMembers).set({ expiredAt: new Date(), isBlocked: true, updatedAt: new Date() })
          .where(eq(vipMembers.id, member.id));
        expired++;
        continue;
      }

      const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
      const groupChatId = group.telegramChatId.toString();
      const userId = member.telegramChatId.toString();
      try {
        await tg.banChatMember(groupChatId, userId);
        await tg.unbanChatMember(groupChatId, userId);
      } catch (err) {
        // 400 (usuário já não está no grupo/chat inválido) é desfecho
        // ESPERADO pra um membro que já pode ter saído sozinho — não impede
        // marcar como expirado.
        const isUserAlreadyGone = err instanceof TelegramApiError && err.errorCode === 400;
        if (isUserAlreadyGone) {
          // segue pro update abaixo, marca expirado normalmente.
        } else if (err instanceof TelegramApiError && err.errorCode === 403) {
          // Bot SEM permissão de admin (ou removido) do grupo: o ban FALHOU e
          // o membro continua lá com acesso — diferente de 400, aqui não é
          // seguro marcar como expirado (mentiria sobre o estado real). Fica
          // pendente: o claim (`expire_claimed_at`) só libera de novo depois
          // de ~10min, então o retry já é espaçado, não a cada tick de 60s.
          console.error(`[vip] bot ${member.botId} sem permissão de admin no grupo ${member.groupId} (chat ${groupChatId}) — ban falhou, membro ${member.id} continua no grupo`);
          const notifyKey = `${member.botId}:${member.groupId}`;
          if (!notifiedGroupPermissionLoss.has(notifyKey)) {
            notifiedGroupPermissionLoss.add(notifyKey);
            void sendPushToUser(bot.userId, {
              eventType: PUSH_EVENT_TYPES.VIP_GROUP_PERMISSION_LOST,
              title: "⚠️ Bot sem permissão no grupo VIP",
              body:  `O bot perdeu a permissão de admin em "${group.name}" — assinaturas vencidas não conseguem mais ser removidas de lá. Adicione o bot como admin de novo.`,
              data:  { url: "/groups" },
            }).catch((e) => console.error("[vip] push de permissão de grupo perdida falhou:", e));
          }
          continue; // não marca expirado nem incrementa — vai pro próximo membro do lote
        } else {
          // Erro inesperado (rede, 429...) — propaga pro catch externo, mesmo
          // efeito de espaçamento via claim.
          throw err;
        }
      }

      await db.update(vipMembers).set({ expiredAt: new Date(), isBlocked: true, updatedAt: new Date() })
        .where(eq(vipMembers.id, member.id));
      expired++;
    } catch (err) {
      console.error(`[vip] expiração do membro ${member.id} falhou (claim expira em 10min p/ nova tentativa):`, err instanceof Error ? err.message : err);
    }
  }
  return expired;
}
