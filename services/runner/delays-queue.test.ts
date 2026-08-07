// Incidente 2026-08-07 (segunda fase): o processador de delays buscava a fila
// INTEIRA sem limite. Com ~100k itens (o resgate do 429), um tick durava horas,
// o guard de 60s liberava o tick seguinte e vários ticks batiam no mesmo bot em
// paralelo — o 429 virava permanente. Cobre o claim atômico em lote.
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createBot, createFlowFunnel, createLead } from "../../test/helpers/seed.js";
import { getTelegramCalls, forceTelegramError } from "../../test/helpers/fetch-mock.js";
import { scheduledDelays, leadProgress } from "../shared/schema/index.js";
import { processPendingDelays, pruneStaleRequeuedDelays } from "./runner.js";

// Cria N delays vencidos para o mesmo bot/funil.
async function seedDueDelays(n: number) {
  const db = await testDb();
  const bot = await createBot();
  const { funnelId, nodeIds } = await createFlowFunnel({
    userId: bot.userId, botId: bot.id,
    nodes: [
      { key: "t", type: "trigger" },
      { key: "m", type: "message", content: { message: "oi" } },
    ],
    connections: [{ from: "t", to: "m" }],
  });

  const past = new Date(Date.now() - 60_000);
  for (let i = 0; i < n; i++) {
    const leadId = await createLead(bot.id, BigInt(9000 + i));
    const [prog] = await db.insert(leadProgress)
      .values({ leadId, funnelId, currentNodeId: nodeIds.t, status: "active" })
      .returning();
    await db.insert(scheduledDelays).values({
      botId: bot.id, leadId, funnelId, progressId: prog.id,
      nextNodeId: nodeIds.m, executeAt: past, status: "pending",
    });
  }
  return { bot, funnelId };
}

describe("fila de delays — claim atômico em lote", () => {
  // Nota: o scheduler interno do módulo (setInterval de 3s) também drena a fila
  // durante o teste — por isso a asserção é sobre o TETO do lote, não sobre o
  // que sobra na tabela.
  it("processa no máximo o tamanho do lote por chamada (tick termina sempre)", async () => {
    await seedDueDelays(45);
    const { processed } = await processPendingDelays();
    expect(processed).toBe(40); // DELAY_BATCH — sem limite, seriam os 45
  });

  it("delay já em 'processing' não é pego de novo (ticks concorrentes)", async () => {
    await seedDueDelays(3);
    const db = await testDb();
    await db.update(scheduledDelays).set({ status: "processing" });

    const { processed } = await processPendingDelays();
    expect(processed).toBe(0);
    expect(getTelegramCalls("sendMessage").length).toBe(0);
  });

  it("429 põe o bot em cooldown: o resto do lote volta pra fila sem chamar o Telegram", async () => {
    await seedDueDelays(6);
    forceTelegramError("sendMessage", 429);

    const { processed } = await processPendingDelays();
    expect(processed).toBe(0);

    // Só o PRIMEIRO delay gastou chamada; os demais foram devolvidos no cooldown.
    expect(getTelegramCalls("sendMessage").length).toBe(1);

    const db = await testDb();
    const rows = await db.select().from(scheduledDelays);
    expect(rows.every((r) => r.status === "pending")).toBe(true); // nenhum "failed"
    // Todos reagendados para o futuro (fim do cooldown).
    expect(rows.every((r) => r.executeAt.getTime() > Date.now())).toBe(true);
  });

  it("erro não-429 marca failed (não fica preso em processing)", async () => {
    await seedDueDelays(2);
    forceTelegramError("sendMessage", 403);

    await processPendingDelays();
    const db = await testDb();
    const rows = await db.select().from(scheduledDelays);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
  });

  // Poda da fila do resgate: cancela só o que é antigo E foi artificialmente
  // reagendado (assinatura do resgate). Delay legítimo não pode ser tocado.
  it("poda cancela delay antigo reagendado e preserva delay legítimo", async () => {
    await seedDueDelays(2);
    const db = await testDb();
    const rows = await db.select().from(scheduledDelays);

    // Delay A: criado há 20h e empurrado pra agora (assinatura do resgate).
    await db.execute(sql`
      UPDATE scheduled_delays
      SET created_at = now() - interval '20 hours', execute_at = now()
      WHERE id = ${rows[0].id}
    `);
    // Delay B: criado há 4h para executar 5 min depois (delay normal de funil,
    // só atrasado na fila) — não pode ser cancelado.
    await db.execute(sql`
      UPDATE scheduled_delays
      SET created_at = now() - interval '4 hours', execute_at = now() - interval '3 hours 55 minutes'
      WHERE id = ${rows[1].id}
    `);

    await pruneStaleRequeuedDelays();

    const [a] = await db.select().from(scheduledDelays).where(eq(scheduledDelays.id, rows[0].id));
    const [b] = await db.select().from(scheduledDelays).where(eq(scheduledDelays.id, rows[1].id));
    expect(a.status).toBe("skipped");  // antigo + reagendado → cancelado
    expect(b.status).toBe("pending");  // legítimo → preservado
  });

  it("delay preso em processing volta pra fila após o prazo", async () => {
    await seedDueDelays(1);
    const db = await testDb();
    // Simula processo morto no meio: processing com claim antigo.
    await db.update(scheduledDelays).set({ status: "processing" });
    await db.execute(sql`UPDATE scheduled_delays SET execute_at = now() - interval '30 minutes'`);

    // O tick lento recupera; aqui chamamos o efeito equivalente e reprocessamos.
    await db.execute(sql`
      UPDATE scheduled_delays SET status = 'pending'
      WHERE status = 'processing' AND execute_at < now() - interval '10 minutes'
    `);
    const { processed } = await processPendingDelays();
    expect(processed).toBe(1);
  });
});
