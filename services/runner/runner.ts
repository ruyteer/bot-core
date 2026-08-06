import { Subscription } from "encore.dev/pubsub";
import { api } from "encore.dev/api";
import { eq, and, lte } from "drizzle-orm";
import { db } from "../shared/database.js";
import { scheduledDelays, bots, leads, leadVariables } from "../shared/schema/index.js";
import { telegramUpdateReceived, paymentPaid } from "../shared/events/index.js";
import { ExecuteFlowStepUseCase } from "./application/execute-flow-step.use-case.js";
import { ExecuteSimplifiedFunnelUseCase } from "./application/execute-simplified-funnel.use-case.js";
import { PaymentDrizzleRepository } from "../payments/infrastructure/payment.drizzle.repository.js";
import { decrypt } from "../shared/crypto.js";
import { TelegramClient } from "./application/telegram.client.js";
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

// Processa todos os delays vencidos uma vez. Reutilizado pelo endpoint manual
// e pelo scheduler interno.
async function runDuePendingDelays(): Promise<number> {
  const pending = await db.select().from(scheduledDelays)
    .where(and(eq(scheduledDelays.status, "pending"), lte(scheduledDelays.executeAt, new Date())));

  let processed = 0;
  for (const delay of pending) {
    try {
      await db.update(scheduledDelays).set({ status: "processing" }).where(eq(scheduledDelays.id, delay.id));

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
    } catch (err) {
      console.error(`[runner] delay ${delay.id} failed:`, err);
      await db.update(scheduledDelays).set({ status: "failed" }).where(eq(scheduledDelays.id, delay.id));
    }
  }

  return processed;
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
void ensureSchemaAtBoot();

setInterval(() => { void tickFast(); }, FAST_TICK_MS);
setInterval(() => { void tickSlow(); }, SLOW_TICK_MS);
