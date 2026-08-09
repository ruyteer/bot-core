import { Subscription } from "encore.dev/pubsub";
import { api } from "encore.dev/api";
import { eq, and, lte, sql } from "drizzle-orm";
import { db } from "../shared/database.js";
import { scheduledDelays, bots, leads, leadVariables, platformConfig } from "../shared/schema/index.js";
import { telegramUpdateReceived, paymentPaid } from "../shared/events/index.js";
import { ExecuteFlowStepUseCase } from "./application/execute-flow-step.use-case.js";
import { ExecuteSimplifiedFunnelUseCase } from "./application/execute-simplified-funnel.use-case.js";
import { PaymentDrizzleRepository } from "../payments/infrastructure/payment.drizzle.repository.js";
import { decrypt } from "../shared/crypto.js";
import { TelegramClient, TelegramApiError } from "./application/telegram.client.js";
import { mergeLeadFields } from "./application/interpolate.js";
import { processDueBroadcasts } from "../broadcasts/application/process-broadcasts.use-case.js";
import { processDueRemarketing, enrollRemarketingTriggers } from "../remarketing/application/process-remarketing.use-case.js";
import { ensureSchemaAtBoot } from "../shared/ensure-schema.js";
import { processPendingConversionEvents } from "../bots/application/pixel-events.js";

const executeFlowStep   = new ExecuteFlowStepUseCase();
const simplifiedFunnel  = new ExecuteSimplifiedFunnelUseCase();
const payRepo           = new PaymentDrizzleRepository();

// ── Telegram update subscriber ────────────────────────────────────────────────

const _sub = new Subscription(telegramUpdateReceived, "runner-process-update", {
  handler: async (event) => {
    try {
      await executeFlowStep.execute({ botId: event.botId, update: event.update });
    } catch (err) {
      console.error(`[runner] error processing update for bot ${event.botId}:`, err);
    }
  },
});

// ── Payment paid subscriber ───────────────────────────────────────────────────
// Quando o webhook confirma um pagamento, entrega o produto e retoma o funil.

const _paidSub = new Subscription(paymentPaid, "runner-payment-paid", {
  handler: async (event) => {
    try {
      const payment = await payRepo.findById(event.paymentId);
      if (!payment) return;
      // Simplificado: entrega itens + agenda upsells. Flow: retoma pelo handle __paid.
      if (payment.simplifiedCtx) await simplifiedFunnel.deliverPaid(payment);
      else                       await executeFlowStep.handlePaidOffer(payment);
    } catch (err) {
      console.error(`[runner] error handling paid payment ${event.paymentId}:`, err);
    }
  },
});

// ── Scheduled delays processor ────────────────────────────────────────────────

// Cooldown por bot após 429: quando o Telegram penaliza um bot (retry_after de
// minutos), tentar os DEMAIS delays dele no mesmo tick só gera mais 429, mais
// updates e mais log. Levou 429 → os delays daquele bot são pulados (ficam
// pending, sem custo) até o prazo passar.
const botRateLimitUntil = new Map<string, number>();

// Quantos delays um tick processa. Com o espaçamento de 40ms + latência do
// Telegram, 40 itens cabem folgados na janela de 3s do tick — e, acima de tudo,
// o tick TERMINA. Sem limite, uma fila grande (ex.: 100k do resgate de 429)
// fazia um tick durar horas: o guard de 60s liberava o próximo, os ticks se
// empilhavam e todos batiam no mesmo bot em paralelo — rajada multiplicada,
// 429 permanente. O claim atômico abaixo é o que impede dois ticks de pegarem
// o mesmo delay.
const DELAY_BATCH = 40;

// Processa um lote de delays vencidos. Reutilizado pelo endpoint manual e pelo
// scheduler interno.
async function runDuePendingDelays(): Promise<number> {
  // Claim atômico: marca "processing" e devolve as linhas numa única query.
  // FOR UPDATE SKIP LOCKED → ticks concorrentes pegam lotes disjuntos.
  // execute_at = now() no claim marca QUANDO o item foi pego: é o relógio que a
  // recuperação de órfãos usa (a tabela não tem updated_at, e created_at daria
  // falso positivo em delay antigo recém-claimed → reprocessamento duplicado).
  const claimed = await db.execute<typeof scheduledDelays.$inferSelect>(sql`
    UPDATE scheduled_delays SET status = 'processing', execute_at = now()
    WHERE id IN (
      SELECT id FROM scheduled_delays
      WHERE status = 'pending' AND execute_at <= now()
      ORDER BY execute_at ASC
      LIMIT ${DELAY_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, bot_id AS "botId", lead_id AS "leadId", funnel_id AS "funnelId",
              progress_id AS "progressId", next_node_id AS "nextNodeId"
  `);
  const pending = (claimed.rows ?? []) as Array<{
    id: string; botId: string; leadId: string;
    funnelId: string; progressId: string; nextNodeId: string;
  }>;

  let processed = 0;
  // 403 (usuário bloqueou o bot / chat inexistente) é desfecho ESPERADO, não
  // incidente: com uma fila grande, logar cada um afoga o Railway. Agrega.
  let blocked = 0;
  for (const delay of pending) {
    const cooldown = botRateLimitUntil.get(delay.botId);
    if (cooldown && Date.now() < cooldown) {
      // Bot penalizado: devolve à fila pro fim do cooldown, sem gastar chamada.
      await db.update(scheduledDelays)
        .set({ status: "pending", executeAt: new Date(cooldown) })
        .where(eq(scheduledDelays.id, delay.id));
      continue;
    }
    try {
      const [bot] = await db.select().from(bots).where(eq(bots.id, delay.botId));
      const [lead] = await db.select().from(leads).where(eq(leads.id, delay.leadId));
      if (!bot || !lead || lead.telegramChatId <= 0n) {
        // !lead, bot inativo, ou chat de grupo/canal (id negativo) → não processa.
        await db.update(scheduledDelays).set({ status: "skipped" }).where(eq(scheduledDelays.id, delay.id));
        continue;
      }

      const tg      = new TelegramClient(decrypt(bot.telegramToken), bot.id);
      const chatId  = lead.telegramChatId.toString();
      const varRows = await db.select().from(leadVariables)
        .where(and(eq(leadVariables.leadId, delay.leadId), eq(leadVariables.botId, delay.botId)));
      const vars = new Map(varRows.map((v) => [v.variableName, v.value]));
      mergeLeadFields(vars, lead);

      await executeFlowStep.resumeFromNode(
        delay.funnelId, delay.nextNodeId, delay.progressId,
        delay.leadId,   delay.botId,     chatId,
        tg, bot.protectContent, vars,
      );

      await db.update(scheduledDelays).set({ status: "done" }).where(eq(scheduledDelays.id, delay.id));
      processed++;

      // Espaçamento entre envios: rajadas de delays vencidos estouravam o rate
      // limit do Telegram (~30 msg/s por bot) e derrubavam funis em massa.
      await new Promise((r) => setTimeout(r, 40));
    } catch (err) {
      if (err instanceof TelegramApiError && err.isRateLimit) {
        // 429 NÃO é falha do funil: reagenda com o retry_after do Telegram
        // (+ jitter pra não realinhar a rajada). Antes virava "failed" e o
        // lead ficava sem o resto do funil pra sempre.
        const waitSec = (err.retryAfter ?? 30) + 5 + Math.floor(Math.random() * 15);
        await db.update(scheduledDelays)
          .set({ status: "pending", executeAt: new Date(Date.now() + waitSec * 1000) })
          .where(eq(scheduledDelays.id, delay.id));
        botRateLimitUntil.set(delay.botId, Date.now() + waitSec * 1000);
        console.warn(`[runner] bot ${delay.botId}: 429 do Telegram — cooldown ${waitSec}s (delay ${delay.id} reagendado)`);
      } else {
        const isBlocked = err instanceof TelegramApiError &&
          (err.errorCode === 403 || err.errorCode === 400);
        if (isBlocked) {
          blocked++;
        } else {
          // Uma linha, sem stack: o stack de centenas de falhas iguais estourou
          // o rate limit de LOG do Railway e escondeu o diagnóstico.
          console.error(`[runner] delay ${delay.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await db.update(scheduledDelays).set({ status: "failed" }).where(eq(scheduledDelays.id, delay.id));
      }
    }
  }

  if (blocked > 0) console.log(`[runner] delays: ${blocked} lead(s) inalcançável(is) (bot bloqueado/chat inválido)`);
  return processed;
}

// ── Poda one-shot da fila do resgate (decisão do usuário, 2026-08-07) ────────
// O resgate reenfileirou 105.977 delays de até 24h. Drenar tudo levaria ~10h,
// mantendo o 429 vivo e entregando continuação de funil defasada — o que gera
// bloqueio e denúncia de spam contra os bots. Mantém só o que falhou nas
// últimas 3h (lead ainda no contexto da conversa) e cancela o resto.
//
// O alvo é identificado pela assinatura do resgate: delay ANTIGO cujo
// execute_at foi empurrado para muito depois da criação. Um delay legítimo de
// funil executa perto de quando foi criado, então não é tocado.
export async function pruneStaleRequeuedDelays(): Promise<void> {
  const MARKER = "RUNNER_PRUNE_STALE_20260807";
  try {
    const inserted = await db.insert(platformConfig)
      .values({ key: MARKER, value: new Date().toISOString() })
      .onConflictDoNothing()
      .returning({ key: platformConfig.key });
    if (inserted.length === 0) return; // já rodou

    const res = await db.execute(sql`
      UPDATE scheduled_delays SET status = 'skipped'
      WHERE status = 'pending'
        AND created_at < now() - interval '3 hours'
        AND execute_at > created_at + interval '2 hours'
    `);
    console.log(`[runner] poda da fila: ${res.rowCount ?? 0} delay(s) antigos (+3h) cancelados`);
  } catch (err) {
    console.error("[runner] poda da fila falhou:", err);
  }
}

// Delays presos em "processing" (processo morto no meio — deploy, OOM) voltam
// pra fila. Sem isso, o claim atômico os deixaria órfãos para sempre.
async function recoverStuckProcessingDelays(): Promise<void> {
  try {
    const res = await db.execute(sql`
      UPDATE scheduled_delays SET status = 'pending'
      WHERE status = 'processing' AND execute_at < now() - interval '10 minutes'
    `);
    if ((res.rowCount ?? 0) > 0) {
      console.log(`[runner] ${res.rowCount} delay(s) presos em processing devolvidos à fila`);
    }
  } catch (err) {
    console.error("[runner] recuperação de delays presos falhou:", err);
  }
}

// ── Resgate one-shot dos delays mortos pelo incidente de 429 (2026-08-07) ────
// Delays marcados "failed" nas últimas 24h eram, na maioria, 429 do Telegram —
// os leads não receberam NADA, então reprocessar é o correto. Escalonados a 2s
// por item pra não recriar a rajada. Marker em platform_config garante uma
// execução única (redeploys não reenviam).
async function requeueIncidentFailedDelays(): Promise<void> {
  const MARKER = "RUNNER_REQUEUE_FAILED_20260807";
  try {
    const inserted = await db.insert(platformConfig)
      .values({ key: MARKER, value: new Date().toISOString() })
      .onConflictDoNothing()
      .returning({ key: platformConfig.key });
    if (inserted.length === 0) return; // já rodou

    const res = await db.execute(sql`
      WITH f AS (
        SELECT id, row_number() OVER (ORDER BY created_at) AS rn
        FROM scheduled_delays
        WHERE status = 'failed' AND created_at > now() - interval '24 hours'
      )
      UPDATE scheduled_delays sd
      SET status = 'pending', execute_at = now() + (f.rn * interval '2 seconds')
      FROM f WHERE sd.id = f.id
    `);
    console.log(`[runner] resgate 429: ${res.rowCount ?? 0} delay(s) failed reenfileirado(s)`);
  } catch (err) {
    console.error("[runner] resgate de delays failed falhou:", err);
  }
}

// Endpoint manual (também útil p/ trigger externo/teste).
export const processPendingDelays = api(
  { method: "POST", path: "/runner/process-delays", expose: false },
  async (): Promise<{ processed: number }> => {
    return { processed: await runDuePendingDelays() };
  },
);

// ── Scheduler interno ─────────────────────────────────────────────────────────
// Os Cron Jobs do Encore só rodam no Encore Cloud; em self-hosted (Railway) não
// disparam. Então processamos a fila com setInterval no próprio processo.
//
// DOIS ticks separados:
// - RÁPIDO (3s): só os delays do funil de fluxo — são o "timing" que o usuário
//   percebe (delay de 3s tem que sair em ~3s, não em até 1min). Query leve.
// - LENTO (60s): tarefas do simplificado, broadcasts e remarketing — não são
//   sensíveis a latência de segundos.
//
// Cada tick tem guarda por TEMPO (não booleana permanente): se um travar (ex.:
// rede), o próximo assume que morreu após o máximo e segue — evita congelar a
// fila pra sempre. Os processadores usam claim atômico ("processing"/"sending"),
// então uma sobreposição eventual não duplica envio.
const FAST_TICK_MS     = 3_000;
const FAST_TICK_MAX_MS = 60_000;
const SLOW_TICK_MS     = 60_000;
const SLOW_TICK_MAX_MS = 3 * 60_000;

let fastRunningSince = 0;
async function tickFast(): Promise<void> {
  const now = Date.now();
  if (fastRunningSince && now - fastRunningSince < FAST_TICK_MAX_MS) return;
  fastRunningSince = now;
  try {
    const n = await runDuePendingDelays();
    if (n > 0) console.log(`[runner] delays: ${n} processado(s)`);
  } catch (err) {
    console.error("[runner] tick rápido (delays) falhou:", err);
  } finally {
    fastRunningSince = 0;
  }
}

let slowRunningSince = 0;
async function tickSlow(): Promise<void> {
  const now = Date.now();
  if (slowRunningSince && now - slowRunningSince < SLOW_TICK_MAX_MS) return;
  slowRunningSince = now;
  try {
    const m = await simplifiedFunnel.processDueTasks();
    const b = await processDueBroadcasts();
    const enrolled = await enrollRemarketingTriggers();
    const rmk = await processDueRemarketing();
    await recoverStuckProcessingDelays();
    const px = await processPendingConversionEvents();
    if (px > 0) console.log(`[runner] scheduler: ${px} evento(s) de pixel processado(s)`);
    if (m > 0) console.log(`[runner] scheduler: ${m} tarefa(s) simplificada(s) processada(s)`);
    if (b > 0) console.log(`[runner] scheduler: ${b} broadcast(s) processado(s)`);
    if (enrolled > 0) console.log(`[runner] scheduler: ${enrolled} lead(s) inscrito(s) em remarketing`);
    if (rmk > 0) console.log(`[runner] scheduler: ${rmk} mensagem(ns) de remarketing enviada(s)`);
  } catch (err) {
    console.error("[runner] tick lento falhou:", err);
  } finally {
    slowRunningSince = 0;
  }
}

// Aplica DDLs idempotentes pendentes antes do 1º tick (self-hosted não tem migrator).
void ensureSchemaAtBoot()
  .then(() => requeueIncidentFailedDelays())
  .then(() => pruneStaleRequeuedDelays());

setInterval(() => { void tickFast(); }, FAST_TICK_MS);
setInterval(() => { void tickSlow(); }, SLOW_TICK_MS);
