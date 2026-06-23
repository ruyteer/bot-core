import { Subscription } from "encore.dev/pubsub";
import { api } from "encore.dev/api";
import { eq, and, lte } from "drizzle-orm";
import { db } from "../shared/database.js";
import { scheduledDelays, bots, leads, leadVariables } from "../shared/schema/index.js";
import { telegramUpdateReceived } from "../shared/events/index.js";
import { ExecuteFlowStepUseCase } from "./application/execute-flow-step.use-case.js";
import { decrypt } from "../shared/crypto.js";
import { TelegramClient } from "./application/telegram.client.js";

const executeFlowStep = new ExecuteFlowStepUseCase();

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
      if (!bot || !lead) {
        await db.update(scheduledDelays).set({ status: "skipped" }).where(eq(scheduledDelays.id, delay.id));
        continue;
      }

      const tg      = new TelegramClient(decrypt(bot.telegramToken));
      const chatId  = lead.telegramChatId.toString();
      const varRows = await db.select().from(leadVariables)
        .where(and(eq(leadVariables.leadId, delay.leadId), eq(leadVariables.botId, delay.botId)));
      const vars = new Map(varRows.map((v) => [v.variableName, v.value]));

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
// disparam. Então processamos a fila com um setInterval no próprio processo.
// A guarda evita sobreposição se um tick demorar mais que o intervalo.
let delaysTickRunning = false;
async function tickDelays(): Promise<void> {
  if (delaysTickRunning) return;
  delaysTickRunning = true;
  try {
    const n = await runDuePendingDelays();
    if (n > 0) console.log(`[runner] scheduler: ${n} delay(s) processado(s)`);
  } catch (err) {
    console.error("[runner] scheduler tick falhou:", err);
  } finally {
    delaysTickRunning = false;
  }
}

setInterval(() => { void tickDelays(); }, 60_000);
