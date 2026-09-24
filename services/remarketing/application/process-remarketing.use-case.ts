import { eq, and, inArray, lte, lt, gte, ne, sql } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  remarketingCampaigns, remarketingMessages, remarketingLeadState,
  bots, leads, payments, funnelOffers, leadProgress,
} from "../../shared/schema/index.js";
import { TelegramClient, TelegramApiError } from "../../runner/application/telegram.client.js";
import { decrypt } from "../../shared/crypto.js";
import { telegramButtonStyle } from "../../runner/application/telegram-button-style.js";

type Unit = "minutes" | "hours" | "days";
const toMs = (value: number, unit: Unit) => {
  const v = Math.max(1, Number(value) || 1);
  return unit === "minutes" ? v * 60_000 : unit === "hours" ? v * 3_600_000 : v * 86_400_000;
};
function replaceVars(text: string, lead: { firstName?: string | null; lastName?: string | null; telegramUsername?: string | null }): string {
  return (text || "")
    .replace(/\{nome\}/gi, lead.firstName ?? "")
    .replace(/\{sobrenome\}/gi, lead.lastName ?? "")
    .replace(/\{username\}/gi, lead.telegramUsername ? `@${lead.telegramUsername}` : "");
}
interface MediaItem { url: string; media_type: string; has_spoiler?: boolean }

async function sendMedia(tg: TelegramClient, chatId: string, items: MediaItem[], caption: string | undefined, replyMarkup: unknown, protect: boolean): Promise<void> {
  const album = items.filter((m) => m.media_type === "image" || m.media_type === "photo" || m.media_type === "video");
  if (items.length >= 2 && album.length >= 2) {
    await tg.sendMediaGroup(chatId, album.map((m, i) => ({ type: m.media_type === "video" ? "video" as const : "photo" as const, media: m.url, caption: i === 0 ? caption : undefined, has_spoiler: !!m.has_spoiler })), protect);
    if (replyMarkup) await tg.sendMessage({ chatId, text: "👇", replyMarkup, protectContent: protect });
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    await tg.sendSingleMedia(chatId, { type: m.media_type, url: m.url, caption: i === 0 ? caption : undefined, hasSpoiler: !!m.has_spoiler, replyMarkup: i === 0 ? replyMarkup : undefined, protect });
  }
}

async function hasPaid(leadId: string): Promise<boolean> {
  const rows = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.leadId, leadId), eq(payments.status, "paid"))).limit(1);
  return rows.length > 0;
}

// ── Enroll automático por gatilho (scan-triggers) ───────────────────────────────
export async function enrollRemarketingTriggers(): Promise<number> {
  const now = new Date();
  const camps = await db.select().from(remarketingCampaigns)
    .where(and(eq(remarketingCampaigns.isActive, true), ne(remarketingCampaigns.triggerType, "manual")));
  let enrolled = 0;

  for (const camp of camps) {
    const rawBotIds = (Array.isArray(camp.botIds) && camp.botIds.length ? camp.botIds : [camp.botId]).map(String);
    // Defesa em profundidade: remarketing_campaigns não tem coluna user_id — o dono da
    // campanha é o dono do bot PRINCIPAL (camp.botId). Se a campanha foi gravada (ou
    // corrompida) com bot_ids de outro dono, nunca inscrevemos leads desse bot aqui —
    // reduz rawBotIds ao subconjunto pertencente ao MESMO dono de camp.botId.
    const [ownerRow] = await db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, camp.botId)).limit(1);
    if (!ownerRow) continue; // bot principal não existe mais — nada seguro a inscrever
    const ownedBotRows = await db.select({ id: bots.id }).from(bots)
      .where(and(inArray(bots.id, rawBotIds), eq(bots.userId, ownerRow.userId)));
    const botIdList = ownedBotRows.map((b) => b.id);
    if (!botIdList.length) continue;
    const cfg = (camp.triggerConfig as Record<string, unknown>) || {};
    let pairs: Array<{ leadId: string; botId: string }> = [];

    if (camp.triggerType === "pix_unpaid") {
      const cutoff = new Date(now.getTime() - Math.max(1, Number(cfg.wait_minutes) || 30) * 60_000);
      // Piso de data: sem isto, ligar este gatilho pegava PIX pendente de
      // QUALQUER época — inclusive de anos antes da campanha existir — e
      // inscrevia tudo de uma vez. Dois limites, o mais recente vale:
      // (a) nunca antes da campanha ter sido criada, e (b) uma janela razoável
      // (padrão 7 dias, configurável via trigger_config.max_age_days) — PIX
      // pendente há meses não é mais "recente" o bastante pra justificar remarketing.
      const maxAgeDays = Math.max(1, Number(cfg.max_age_days) || 7);
      const floor = new Date(Math.max(camp.createdAt.getTime(), now.getTime() - maxAgeDays * 86_400_000));
      const rows = await db.select({ leadId: payments.leadId, botId: payments.botId }).from(payments)
        .where(and(inArray(payments.botId, botIdList), eq(payments.status, "pending"), lt(payments.createdAt, cutoff), gte(payments.createdAt, floor))).limit(500);
      pairs = rows.filter((r) => r.leadId).map((r) => ({ leadId: r.leadId!, botId: r.botId }));
    } else if (camp.triggerType === "buyers") {
      const cutoff = new Date(now.getTime() - Math.max(0, Number(cfg.wait_minutes) || 0) * 60_000);
      const rows = await db.select({ leadId: payments.leadId, botId: payments.botId }).from(payments)
        .where(and(inArray(payments.botId, botIdList), eq(payments.status, "paid"), lt(payments.paidAt, cutoff))).limit(500);
      pairs = rows.filter((r) => r.leadId).map((r) => ({ leadId: r.leadId!, botId: r.botId }));
    } else if (camp.triggerType === "inactivity") {
      const cutoff = new Date(now.getTime() - Math.max(1, Number(cfg.inactive_days) || 7) * 86_400_000);
      const rows = await db.select({ id: leads.id, botId: leads.botId }).from(leads)
        .where(and(inArray(leads.botId, botIdList), lt(leads.updatedAt, cutoff))).limit(500);
      pairs = rows.map((r) => ({ leadId: r.id, botId: r.botId }));
    } else {
      continue; // vip_expired não suportado (schema sem coluna de expiração)
    }
    if (!pairs.length) continue;

    // Dedup lead + já inscritos
    const seen = new Set<string>();
    pairs = pairs.filter((p) => (seen.has(p.leadId) ? false : (seen.add(p.leadId), true)));
    const leadIds = [...seen];
    const existing = await db.select({ leadId: remarketingLeadState.leadId }).from(remarketingLeadState)
      .where(and(eq(remarketingLeadState.campaignId, camp.id), inArray(remarketingLeadState.leadId, leadIds)));
    const existingSet = new Set(existing.map((e) => e.leadId));
    const rows = pairs.filter((p) => !existingSet.has(p.leadId)).map((p) => ({
      campaignId: camp.id, leadId: p.leadId, botId: p.botId,
      nextMessageIndex: 0, nextSendAt: now, status: "active",
    }));
    // onConflictDoNothing é a rede de segurança contra a corrida entre replicas do
    // runner (cada uma roda seu próprio setInterval sem lock distribuído — ver
    // runner.ts): se duas replicas fizerem o SELECT de `existing` antes de qualquer
    // uma inserir, a constraint única em (campaign_id, lead_id) garante que só a
    // primeira INSERT vinga e a segunda é ignorada, em vez de criar uma linha
    // duplicada que seria processada (e enviada) duas vezes.
    if (rows.length) {
      const inserted = await db.insert(remarketingLeadState).values(rows)
        .onConflictDoNothing({ target: [remarketingLeadState.campaignId, remarketingLeadState.leadId] })
        .returning({ id: remarketingLeadState.id });
      enrolled += inserted.length;
    }
  }
  return enrolled;
}

// ── Reativação de campanha: retoma leads pausados por ela ter sido desligada ────
// Só os estados pausados com pause_reason='campaign_inactive' voltam a 'active' —
// nunca os pausados por outro motivo (ex.: no_messages, que precisa de mensagens
// cadastradas antes de voltar a rodar) nem os já 'stopped'/'blocked'/'completed'
// (esses têm as próprias regras, ou nenhuma retomada — ver reinscrição manual).
//
// Reagendamento: espalha o nextSendAt em vez de marcar now() pra todo mundo de
// uma vez (uma campanha pausada há semanas pode ter milhares de leads acumulados
// e uma reativação não pode virar uma rajada só porque todos ficaram "devidos" no
// mesmo instante). Escalona 15s por lead via row_number() — mesma técnica usada
// em requeueIncidentFailedDelays (runner.ts) para o mesmo tipo de problema. Isso
// soma-se ao limite de 50 estados por chamada em processDueRemarketing: mesmo uma
// reativação enorme nunca compete de golpe com o tráfego normal de outras
// campanhas, e o próprio claim já limita quantos saem por tick de qualquer forma.
export async function resumeLeadsAfterReactivation(campaignId: string): Promise<number> {
  // Conta por RETURNING (res.rows), não por res.rowCount: o driver de produção
  // (node-postgres) preenche rowCount, mas o PGlite usado nos testes só expõe
  // affectedRows — RETURNING + rows.length funciona igual nos dois.
  const res = await db.execute(sql`
    WITH p AS (
      SELECT id, row_number() OVER (ORDER BY updated_at) AS rn
      FROM remarketing_lead_state
      WHERE campaign_id = ${campaignId} AND status = 'paused' AND pause_reason = 'campaign_inactive'
    )
    UPDATE remarketing_lead_state rls
    SET status = 'active', pause_reason = NULL, updated_at = now(),
        next_send_at = now() + (p.rn * interval '15 seconds')
    FROM p WHERE rls.id = p.id
    RETURNING rls.id
  `);
  return res.rows.length;
}

// ── Lead respondeu: para remarketing das campanhas com stop_on_reply ────────────
// `stop_on_reply` é gravado na criação/edição da campanha (remarketing.api.ts)
// mas nunca era lido em lugar nenhum — o runner ignorava a opção e continuava
// mandando mensagem mesmo depois do lead responder. Chamado pelo runner (ver
// execute-flow-step.use-case.ts) sempre que UMA mensagem inbound do lead é
// salva em lead_messages (texto, mídia ou clique de botão), para toda campanha
// com essa opção ligada em que o lead ainda esteja inscrito e ativo/pausado —
// nunca reabre um estado já 'stopped'/'blocked'/'completed' por outro motivo.
export async function stopRemarketingOnLeadReply(leadId: string): Promise<void> {
  await db.execute(sql`
    UPDATE remarketing_lead_state rls
    SET status = 'stopped', pause_reason = 'lead_replied', updated_at = now()
    FROM remarketing_campaigns c
    WHERE rls.campaign_id = c.id
      AND rls.lead_id = ${leadId}
      AND c.stop_on_reply = true
      AND rls.status IN ('active', 'paused')
  `);
}

// ── Processa estados vencidos (envia a próxima mensagem da sequência) ───────────

// Backoff exponencial para falha TRANSITÓRIA de envio (rede, 5xx, 429 sem
// retry_after informado): 5min, 15min, 45min, 2h15... até um teto de 6h. Falha
// transitória nunca bloqueia o lead (ver classifyTelegramFailure) — sem um
// backoff crescente, uma instabilidade prolongada do Telegram martelaria a API
// a cada tick em vez de dar espaço pra ela se recuperar.
function transientBackoffMs(consecutiveErrors: number): number {
  const minutes = Math.min(5 * 3 ** Math.max(0, consecutiveErrors - 1), 360);
  return minutes * 60_000;
}

type SendFailure = { kind: "permanent"; reason: string } | { kind: "transient" };

// Distingue falha DEFINITIVA (lead inalcançável por este bot pra sempre — vale
// bloquear) de TRANSITÓRIA (rede, 5xx, 429 — vale só tentar de novo depois).
// Usa o errorCode real da API do Telegram (TelegramApiError, ver telegram.client.ts)
// em vez de adivinhar pela mensagem genérica. Only 403 (Forbidden — bot
// bloqueado, conta desativada, removido do chat) e o 400 específico "chat not
// found" contam como definitivos; qualquer outro erro (incluindo outros 400,
// timeout, erro de rede sem TelegramApiError) é tratado como transitório —
// bloquear por engano é irreversível pro lead, então o padrão é o lado seguro.
function classifyTelegramFailure(err: unknown): SendFailure {
  if (err instanceof TelegramApiError) {
    if (err.errorCode === 403) return { kind: "permanent", reason: "blocked_by_user" };
    if (err.errorCode === 400 && /chat not found/i.test(err.message)) return { kind: "permanent", reason: "chat_not_found" };
  }
  return { kind: "transient" };
}

// Quanto tempo esperar antes de checar de novo um lead pausado manualmente (ver
// guard "Lead em atendimento humano" abaixo).
const PAUSED_RECHECK_MS = 30 * 60_000;

export async function processDueRemarketing(): Promise<number> {
  const now = new Date();
  // Recupera travados
  await db.update(remarketingLeadState).set({ status: "active", updatedAt: now })
    .where(and(eq(remarketingLeadState.status, "processing"), lt(remarketingLeadState.updatedAt, new Date(now.getTime() - 10 * 60_000))));
  // Claim
  const cand = await db.select({ id: remarketingLeadState.id }).from(remarketingLeadState)
    .where(and(eq(remarketingLeadState.status, "active"), lte(remarketingLeadState.nextSendAt, now))).limit(50);
  if (!cand.length) return 0;
  const claimed = await db.update(remarketingLeadState).set({ status: "processing", updatedAt: now })
    .where(and(inArray(remarketingLeadState.id, cand.map((c) => c.id)), eq(remarketingLeadState.status, "active"))).returning();

  let processed = 0;
  const msgCache = new Map<string, Array<typeof remarketingMessages.$inferSelect>>();
  const botCache = new Map<string, typeof bots.$inferSelect | undefined>();

  for (const st of claimed) {
    try {
      // Toque otimista (CAS em status+updatedAt): se este lote demorar mais que os
      // 10min do resgate de travados acima (ex.: vários envios lentos/timeout em
      // sequência), outra réplica pode ter recuperado ESTA linha (status voltou p/
      // "active") e reclamado de novo antes de chegarmos aqui. Nesse caso o UPDATE
      // abaixo não afeta nenhuma linha (status/updatedAt não batem mais) e pulamos
      // o envio em vez de duplicar — a outra réplica agora é a dona da linha.
      const touched = await db.update(remarketingLeadState).set({ updatedAt: now })
        .where(and(eq(remarketingLeadState.id, st.id), eq(remarketingLeadState.status, "processing"), eq(remarketingLeadState.updatedAt, st.updatedAt)))
        .returning({ id: remarketingLeadState.id });
      if (!touched.length) continue;

      const [camp] = await db.select().from(remarketingCampaigns).where(eq(remarketingCampaigns.id, st.campaignId));
      if (!camp || !camp.isActive) { await db.update(remarketingLeadState).set({ status: "paused", pauseReason: "campaign_inactive", updatedAt: now }).where(eq(remarketingLeadState.id, st.id)); continue; }
      // Gatilho "buyers" com stopOnPurchase=true nunca envia (hasPaid() é sempre
      // true pra quem esse gatilho inscreve) — create/update em remarketing.api.ts
      // já forçam stopOnPurchase=false ao salvar uma campanha com esse gatilho.
      // NÃO corrigimos aqui por baixo (defesa em profundidade) de propósito:
      // campanhas 'buyers' já gravadas com essa combinação estão ativas e
      // silenciosas em produção possivelmente há muito tempo, e o gatilho
      // 'buyers' inscreve compradores HISTÓRICOS (sem piso de data — ver
      // enrollRemarketingTriggers), não só recentes. Reativar esse envio por
      // baixo dos panos mandaria mensagem de uma vez pra todo comprador antigo
      // já inscrito, sem o dono da conta ter mexido na campanha. Só passa a
      // enviar quando o usuário conscientemente cria ou edita a campanha (rota
      // que já corrige o campo).
      if (camp.stopOnPurchase && await hasPaid(st.leadId)) { await db.update(remarketingLeadState).set({ status: "stopped", pauseReason: "purchased", updatedAt: now }).where(eq(remarketingLeadState.id, st.id)); continue; }

      if (!msgCache.has(st.campaignId)) {
        const m = await db.select().from(remarketingMessages).where(eq(remarketingMessages.campaignId, st.campaignId));
        msgCache.set(st.campaignId, m.sort((a, b) => a.orderIndex - b.orderIndex));
      }
      const messages = msgCache.get(st.campaignId)!;
      if (!messages.length) { await db.update(remarketingLeadState).set({ status: "paused", pauseReason: "no_messages", updatedAt: now }).where(eq(remarketingLeadState.id, st.id)); continue; }

      const idx = ((st.nextMessageIndex % messages.length) + messages.length) % messages.length;
      const msg = messages[idx];
      const [lead] = await db.select().from(leads).where(eq(leads.id, st.leadId));
      if (!lead) { await db.update(remarketingLeadState).set({ status: "stopped", pauseReason: "lead_not_found", updatedAt: now }).where(eq(remarketingLeadState.id, st.id)); continue; }
      // Grupo/canal (id negativo) nunca é alvo de remarketing.
      if (lead.telegramChatId <= 0n) { await db.update(remarketingLeadState).set({ status: "stopped", pauseReason: "not_a_user", updatedAt: now }).where(eq(remarketingLeadState.id, st.id)); continue; }

      // Lead em atendimento humano (pausado manualmente — leads.api.ts PATCH
      // .../pause seta leadProgress.status='paused_manual', mesmo flag que o
      // runner respeita pra travar a automação do funil, ver execute-flow-step
      // .use-case.ts) não deve receber remarketing enquanto durar a pausa. Só
      // adia a próxima tentativa (mantém status/índice intactos) em vez de
      // marcar o estado como parado — quando o atendente retomar, a sequência
      // volta sozinha no próximo tick, sem precisar de rotina de reativação.
      const [pausedProgress] = await db.select({ id: leadProgress.id }).from(leadProgress)
        .where(and(eq(leadProgress.leadId, st.leadId), eq(leadProgress.status, "paused_manual"))).limit(1);
      if (pausedProgress) {
        await db.update(remarketingLeadState).set({ status: "active", nextSendAt: new Date(now.getTime() + PAUSED_RECHECK_MS), updatedAt: now }).where(eq(remarketingLeadState.id, st.id));
        continue;
      }

      // Envia SEMPRE pelo bot do estado, não pelo bot principal da campanha:
      // uma campanha com vários `bot_ids` inscreve o lead de cada bot, e usar
      // camp.botId fazia a mesma pessoa receber a mesma mensagem duas vezes
      // pelo mesmo bot (uma por linha de estado).
      const sendBotId = st.botId || camp.botId;
      if (!botCache.has(sendBotId)) { const [b] = await db.select().from(bots).where(eq(bots.id, sendBotId)); botCache.set(sendBotId, b); }
      const bot = botCache.get(sendBotId);
      if (!bot) { await db.update(remarketingLeadState).set({ status: "error", pauseReason: "bot_missing", updatedAt: now }).where(eq(remarketingLeadState.id, st.id)); continue; }

      // Defesa em profundidade: campanhas gravadas (ou corrompidas) ANTES desta checagem
      // existir com um bot_ids de outro dono — ou um lead_state com bot_id divergente —
      // nunca devem continuar enviando. Confirma que o bot que vai enviar (a) pertence ao
      // MESMO dono do bot principal da campanha e (b) está de fato listado em bot_ids.
      if (!botCache.has(camp.botId)) { const [b] = await db.select().from(bots).where(eq(bots.id, camp.botId)); botCache.set(camp.botId, b); }
      const ownerBot = botCache.get(camp.botId);
      const campaignBotIds = (Array.isArray(camp.botIds) && camp.botIds.length ? (camp.botIds as string[]).map(String) : [camp.botId]);
      if (!ownerBot || bot.userId !== ownerBot.userId || !campaignBotIds.includes(sendBotId)) {
        await db.update(remarketingLeadState).set({ status: "stopped", pauseReason: "bot_not_owned", updatedAt: now }).where(eq(remarketingLeadState.id, st.id));
        continue;
      }

      const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
      const chatId = lead.telegramChatId.toString();
      const text = replaceVars(msg.message || "", lead);
      const media = (Array.isArray(msg.media) ? msg.media : (msg.media && typeof msg.media === "object" && Array.isArray((msg.media as { items?: unknown }).items) ? (msg.media as { items: MediaItem[] }).items : [])) as MediaItem[];
      const buttons = (Array.isArray(msg.inlineButtons) ? msg.inlineButtons : []) as Array<{ text?: string; url?: string; style?: unknown }>;
      const kb: Array<Array<Record<string, unknown>>> = buttons.filter((b) => b?.text && b?.url).map((b) => {
        const style = telegramButtonStyle(b.style);
        return [{ text: String(b.text), url: String(b.url), ...(style ? { style } : {}) }];
      });
      // Oferta anexada → botão de compra (bcast_buy), tratado pelo runner.
      if (msg.offerId) {
        // Oferta é escopada por bot: precisa ser a do bot que está enviando,
        // senão o callback bcast_buy cairia num bot que não conhece a oferta.
        const [off] = await db.select().from(funnelOffers).where(and(eq(funnelOffers.id, msg.offerId), eq(funnelOffers.botId, sendBotId)));
        if (off) {
          const offerStyle = telegramButtonStyle(msg.offerStyle);
          kb.push([{ text: `🛒 ${off.name} — ${(Number(off.price) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`, callback_data: `bcast_buy_${off.id}`, ...(offerStyle ? { style: offerStyle } : {}) }]);
        }
      }
      const replyMarkup = kb.length ? { inline_keyboard: kb } : undefined;

      let sentOk = true;
      let sendError: unknown = null;
      try {
        if (media.length > 0) await sendMedia(tg, chatId, media, text || undefined, replyMarkup, bot.protectContent);
        else if (text) await tg.sendMessage({ chatId, text, replyMarkup, protectContent: bot.protectContent });
      } catch (e) { sentOk = false; sendError = e; console.error("[remarketing] envio falhou:", st.id, e); }

      if (!sentOk) {
        const errMsg = sendError instanceof Error ? sendError.message : String(sendError);
        const failure = classifyTelegramFailure(sendError);
        if (failure.kind === "permanent") {
          // Falha definitiva (bot bloqueado, chat inexistente etc.): bloqueia
          // JÁ, sem esperar N tentativas — esperar só adiaria o inevitável e
          // continuaria consumindo o índice da sequência à toa. NÃO avança
          // nextMessageIndex/cyclesCompleted: a mensagem nunca vai chegar de
          // qualquer forma, e blocked é terminal (não há próxima tentativa).
          await db.update(remarketingLeadState).set({
            status: "blocked", pauseReason: failure.reason, lastError: errMsg,
            consecutiveErrors: (st.consecutiveErrors || 0) + 1, updatedAt: now,
          }).where(eq(remarketingLeadState.id, st.id));
          continue;
        }
        // Falha TRANSITÓRIA (rede, 5xx, 429, timeout): nunca bloqueia o lead.
        // Não avança nextMessageIndex — a mensagem que falhou é reenviada na
        // próxima tentativa em vez de "pulada" silenciosamente (bug original).
        // 429 é um caso à parte: o Telegram já diz exatamente quanto esperar
        // (retry_after), então usamos isso direto (+ jitter, mesma fórmula do
        // resgate de delays de funil em runner.ts) em vez do backoff genérico
        // — que existe justamente para quando NÃO sabemos quanto esperar.
        const newConsecutive = (st.consecutiveErrors || 0) + 1;
        const isRateLimit = sendError instanceof TelegramApiError && sendError.isRateLimit;
        const waitMs = isRateLimit
          ? ((sendError as TelegramApiError).retryAfter ?? 30) * 1000 + 5000 + Math.floor(Math.random() * 15000)
          : transientBackoffMs(newConsecutive);
        await db.update(remarketingLeadState).set({
          nextSendAt: new Date(now.getTime() + waitMs),
          lastError: errMsg, consecutiveErrors: newConsecutive, status: "active", updatedAt: now,
        }).where(eq(remarketingLeadState.id, st.id));
        continue;
      }

      const nextIdx = (idx + 1) % messages.length;
      const cyclesInc = nextIdx === 0 ? 1 : 0;
      const newCycles = (st.cyclesCompleted || 0) + cyclesInc;
      const baseTs = Math.max(now.getTime(), new Date(st.nextSendAt).getTime());
      const nextSend = new Date(baseTs + toMs(msg.delayValue || 1, (msg.delayUnit || "days") as Unit));
      const maxedOut = camp.maxCycles != null && newCycles >= camp.maxCycles;

      await db.update(remarketingLeadState).set({
        nextMessageIndex: nextIdx, nextSendAt: nextSend, cyclesCompleted: newCycles,
        totalSent: (st.totalSent || 0) + 1, lastSentAt: now,
        lastError: null, consecutiveErrors: 0,
        pauseReason: maxedOut ? "max_cycles" : null, status: maxedOut ? "completed" : "active", updatedAt: now,
      }).where(eq(remarketingLeadState.id, st.id));

      // totalMessagesSent não é mais mantido aqui: o valor é derivado de remarketing_lead_state.total_sent
      // na API (evita o read-modify-write concorrente entre réplicas que perdia incrementos).
      processed++;
    } catch (e) {
      console.error("[remarketing] estado falhou:", st.id, e);
      await db.update(remarketingLeadState).set({ status: "active", updatedAt: now }).where(eq(remarketingLeadState.id, st.id)).catch(() => {});
    }
  }
  return processed;
}
