import { eq, and, ne, desc } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  leads, leadProgress, leadVariables, leadMessages,
  funnels, funnelNodes, nodeConnections, scheduledDelays, bots,
} from "../../shared/schema/index.js";
import { TelegramClient } from "./telegram.client.js";
import { decrypt } from "../../shared/crypto.js";
import { interpolate } from "./interpolate.js";
import type { TelegramUpdate } from "../../shared/events/index.js";

interface ExecutionContext {
  botId:  string;
  update: TelegramUpdate;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Texto dos nós é plano (textarea), mas o Telegram usa parse_mode HTML por padrão.
// Sem escapar, um `<`, `>` ou `&` no texto faz o Telegram rejeitar e abortar o passo.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getVars(leadId: string, botId: string): Promise<Map<string, string>> {
  const rows = await db.select().from(leadVariables)
    .where(and(eq(leadVariables.leadId, leadId), eq(leadVariables.botId, botId)));
  return new Map(rows.map((r) => [r.variableName, r.value]));
}

async function setVar(leadId: string, botId: string, name: string, value: string): Promise<void> {
  await db.insert(leadVariables).values({ leadId, botId, variableName: name, value })
    .onConflictDoUpdate({
      target: [leadVariables.leadId, leadVariables.variableName],
      set:    { value, updatedAt: new Date() },
    });
}

async function saveOutbound(leadId: string, botId: string, content: Record<string, unknown>): Promise<void> {
  await db.insert(leadMessages).values({ leadId, botId, direction: "outbound", content });
}

async function saveInbound(leadId: string, botId: string, content: Record<string, unknown>): Promise<void> {
  await db.insert(leadMessages).values({ leadId, botId, direction: "inbound", content });
}

async function nextNode(funnelId: string, sourceNodeId: string, sourceHandle?: string): Promise<string | null> {
  const conditions = sourceHandle
    ? and(eq(nodeConnections.funnelId, funnelId), eq(nodeConnections.sourceNodeId, sourceNodeId), eq(nodeConnections.sourceHandle, sourceHandle))
    : and(eq(nodeConnections.funnelId, funnelId), eq(nodeConnections.sourceNodeId, sourceNodeId));
  const [conn] = await db.select().from(nodeConnections).where(conditions).limit(1);
  return conn?.targetNodeId ?? null;
}

async function advanceProgress(progressId: string, nodeId: string | null, status: string): Promise<void> {
  await db.update(leadProgress).set({ currentNodeId: nodeId, status, updatedAt: new Date() })
    .where(eq(leadProgress.id, progressId));
}

// ── Main use case ─────────────────────────────────────────────────────────────

export class ExecuteFlowStepUseCase {
  async execute(ctx: ExecutionContext): Promise<void> {
    const { botId, update } = ctx;

    // Identify sender + message text
    const from = update.message?.from ?? update.callback_query?.from;
    if (!from) return;

    const chatId = BigInt(update.message?.chat.id ?? from.id);
    const messageText = update.message?.text ?? null;
    const callbackData = update.callback_query?.data ?? null;
    const callbackQueryId = update.callback_query?.id ?? null;

    // Get bot token (for Telegram API calls)
    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) return;
    const tg = new TelegramClient(decrypt(bot.telegramToken));
    const chatIdStr = chatId.toString();

    // Upsert lead
    const [lead] = await db.insert(leads).values({
      botId,
      telegramChatId:   chatId,
      telegramUsername: from.username ?? null,
      firstName:        from.first_name ?? null,
      lastName:         (from as { last_name?: string }).last_name ?? null,
    }).onConflictDoUpdate({
      target: [leads.botId, leads.telegramChatId],
      set: {
        telegramUsername: from.username ?? null,
        firstName:        from.first_name ?? null,
        lastName:         (from as { last_name?: string }).last_name ?? null,
        updatedAt:        new Date(),
      },
    }).returning();

    // Save inbound message
    if (messageText) {
      await saveInbound(lead.id, botId, { kind: "text", text: messageText });
    }

    // Answer callback immediately to stop Telegram spinner
    if (callbackQueryId) {
      await tg.answerCallbackQuery({ callbackQueryId }).catch(() => {});
    }

    // Check if lead is manually paused — drop all automation
    const [prog] = await db.select().from(leadProgress)
      .where(eq(leadProgress.leadId, lead.id));
    if (prog?.status === "paused_manual") return;

    const vars = await getVars(lead.id, botId);

    // ── /start command: enter funnel ────────────────────────────────────────
    if (messageText === "/start" || !prog) {
      // Só funis de fluxo são executáveis aqui (o simplificado não tem nós).
      // orderBy + limit p/ ser determinístico quando há mais de um ativo.
      const [activeFunnel] = await db.select().from(funnels)
        .where(and(
          eq(funnels.botId, botId),
          eq(funnels.isActive, true),
          ne(funnels.kind, "simplified"),
        ))
        .orderBy(desc(funnels.updatedAt))
        .limit(1);
      if (!activeFunnel) return;

      // Find trigger node
      const [triggerNode] = await db.select().from(funnelNodes)
        .where(and(eq(funnelNodes.funnelId, activeFunnel.id), eq(funnelNodes.type, "trigger")));
      if (!triggerNode) return;

      // Create or replace progress
      if (prog) {
        await db.update(leadProgress)
          .set({ funnelId: activeFunnel.id, currentNodeId: triggerNode.id, status: "active", updatedAt: new Date() })
          .where(eq(leadProgress.id, prog.id));
      } else {
        await db.insert(leadProgress).values({
          leadId:        lead.id,
          funnelId:      activeFunnel.id,
          currentNodeId: triggerNode.id,
          status:        "active",
        });
      }

      // Execute from the node AFTER the trigger
      const afterTriggerId = await nextNode(activeFunnel.id, triggerNode.id);
      if (afterTriggerId) {
        const [newProg] = await db.select().from(leadProgress).where(eq(leadProgress.leadId, lead.id));
        await this.runNode(activeFunnel.id, afterTriggerId, newProg.id, lead.id, botId, chatIdStr, tg, bot.protectContent, vars, null);
      }
      return;
    }

    // ── Handle button callback ───────────────────────────────────────────────
    if (callbackData && prog) {
      const currentNode = prog.currentNodeId
        ? (await db.select().from(funnelNodes).where(eq(funnelNodes.id, prog.currentNodeId)))[0]
        : null;

      if (currentNode?.type === "buttons") {
        const nextId = await nextNode(prog.funnelId, currentNode.id, callbackData);
        if (nextId) {
          await advanceProgress(prog.id, nextId, "active");
          await this.runNode(prog.funnelId, nextId, prog.id, lead.id, botId, chatIdStr, tg, bot.protectContent, vars, null);
        }
        return;
      }
    }

    // ── Handle text response for input node ─────────────────────────────────
    if (messageText && prog) {
      const currentNode = prog.currentNodeId
        ? (await db.select().from(funnelNodes).where(eq(funnelNodes.id, prog.currentNodeId)))[0]
        : null;

      if (currentNode?.type === "input" || currentNode?.type === "wait_response") {
        const c = currentNode.content as { variable_name?: string };
        if (c.variable_name) {
          await setVar(lead.id, botId, c.variable_name, messageText);
          vars.set(c.variable_name, messageText);
        }
        const nextId = await nextNode(prog.funnelId, currentNode.id);
        if (nextId) {
          await advanceProgress(prog.id, nextId, "active");
          await this.runNode(prog.funnelId, nextId, prog.id, lead.id, botId, chatIdStr, tg, bot.protectContent, vars, null);
        }
      }
    }
  }

  // ── Public: resume from a specific node (used by delay processor) ───────────

  async resumeFromNode(
    funnelId:   string,
    nodeId:     string,
    progressId: string,
    leadId:     string,
    botId:      string,
    chatId:     string,
    tg:         TelegramClient,
    protect:    boolean,
    vars:       Map<string, string>,
  ): Promise<void> {
    await this.runNode(funnelId, nodeId, progressId, leadId, botId, chatId, tg, protect, vars, null);
  }

  // ── Node runner ─────────────────────────────────────────────────────────────

  private async runNode(
    funnelId:       string,
    nodeId:         string,
    progressId:     string,
    leadId:         string,
    botId:          string,
    chatId:         string,
    tg:             TelegramClient,
    protect:        boolean,
    vars:           Map<string, string>,
    _parentNodeId:  string | null,
    depth = 0,
  ): Promise<void> {
    if (depth > 50) return; // prevent infinite loops

    const [node] = await db.select().from(funnelNodes).where(eq(funnelNodes.id, nodeId));
    if (!node) return;

    const c = node.content as Record<string, unknown>;
    await advanceProgress(progressId, node.id, "active");

    switch (node.type) {
      case "message":
        await this.executeMessageNode(c, chatId, tg, protect, vars);
        await saveOutbound(leadId, botId, { ...c, nodeId: node.id });
        break;

      case "media":
        await this.executeMediaNode(c, chatId, tg, protect, vars);
        await saveOutbound(leadId, botId, { ...c, nodeId: node.id });
        break;

      case "audio": {
        const url     = c.url as string | undefined;
        const caption = typeof c.caption === "string" ? interpolate(c.caption, vars) : undefined;
        if (url) await tg.sendAudio(chatId, url, caption, protect);
        await saveOutbound(leadId, botId, { kind: "audio", url, nodeId: node.id });
        break;
      }

      case "buttons":
        await this.executeButtonsNode(c, chatId, tg, protect, vars);
        await saveOutbound(leadId, botId, { ...c, nodeId: node.id });
        // Stay on this node waiting for callback
        await advanceProgress(progressId, node.id, "active");
        return;

      case "input":
      case "wait_response": {
        // Stay on this node; next step triggered by inbound message.
        // O frontend salva a pergunta em `question`; fallback p/ `prompt` antigo.
        await advanceProgress(progressId, node.id, "active");
        const promptRaw = (c.question ?? c.prompt) as string | undefined;
        if (promptRaw) {
          const prompt = escapeHtml(interpolate(promptRaw, vars));
          await tg.sendMessage({ chatId, text: prompt, protectContent: protect });
          await saveOutbound(leadId, botId, { kind: "text", text: prompt, nodeId: node.id });
        }
        return;
      }

      case "delay": {
        // Frontend salva `seconds`; fallback p/ o par value/unit antigo.
        let seconds: number;
        if (typeof c.seconds === "number") {
          seconds = c.seconds;
        } else {
          const value = (c.value as number) ?? 0;
          const unit  = (c.unit as string) ?? "seconds";
          seconds = unit === "minutes" ? value * 60 : unit === "hours" ? value * 3600 : value;
        }
        const ms     = seconds * 1000;
        const nextId = await nextNode(funnelId, node.id);
        if (nextId && ms > 0) {
          await db.insert(scheduledDelays).values({
            botId,
            leadId,
            funnelId,
            progressId,
            nextNodeId: nextId,
            executeAt:  new Date(Date.now() + ms),
            status:     "pending",
          });
          await advanceProgress(progressId, null, "active");
        } else if (nextId) {
          // Zero delay — continue immediately
          await this.runNode(funnelId, nextId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
        }
        return;
      }

      case "condition": {
        const varName  = c.variable_name as string | undefined;
        const operator = c.operator as string | undefined;
        const expected = c.value as string | undefined;
        const actual   = varName ? (vars.get(varName) ?? "") : "";

        let branch = "false";
        if (operator === "equals")       branch = actual === expected ? "true" : "false";
        else if (operator === "contains") branch = actual.includes(expected ?? "") ? "true" : "false";
        else if (operator === "not_empty") branch = actual.length > 0 ? "true" : "false";

        const nextId = await nextNode(funnelId, node.id, branch);
        if (nextId) {
          await this.runNode(funnelId, nextId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
        }
        return;
      }

      case "random": {
        const connections = await db.select().from(nodeConnections)
          .where(and(eq(nodeConnections.funnelId, funnelId), eq(nodeConnections.sourceNodeId, node.id)));
        if (connections.length > 0) {
          const pick = connections[Math.floor(Math.random() * connections.length)];
          await this.runNode(funnelId, pick.targetNodeId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
        }
        return;
      }

      case "offer":
        // Offer node sends a message and waits for payment — no automation advance here
        await this.executeOfferNode(c, chatId, tg, protect, vars);
        await saveOutbound(leadId, botId, { ...c, kind: "offer", nodeId: node.id });
        await advanceProgress(progressId, node.id, "active");
        return;
    }

    // Advance to next node automatically for non-blocking nodes
    const nextId = await nextNode(funnelId, node.id);
    if (nextId) {
      await this.runNode(funnelId, nextId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
    } else {
      await advanceProgress(progressId, null, "completed");
    }
  }

  private async executeMessageNode(
    c:       Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
  ): Promise<void> {
    // O frontend salva o texto em `message` (tanto no nó simples quanto em cada
    // bloco); mantemos fallback p/ `content`/`text` de versões antigas.
    const blocks = (c.blocks as Array<Record<string, unknown>>) ?? [];

    if (blocks.length > 0) {
      for (const block of blocks) {
        const url       = block.url as string | undefined;
        const text      = (block.message ?? block.content ?? block.text) as string | undefined;
        const caption   = typeof block.caption === "string" ? escapeHtml(interpolate(block.caption, vars)) : undefined;
        const mediaType = (block.media_type ?? block.type) as string | undefined;

        if (block.type === "text" && text) {
          await tg.sendMessage({ chatId, text: escapeHtml(interpolate(text, vars)), protectContent: protect });
        } else if ((block.type === "media" || block.type === "image" || block.type === "video" || block.type === "document") && url) {
          if (mediaType === "video")         await tg.sendVideo(chatId, url, caption, protect);
          else if (mediaType === "document") await tg.sendDocument(chatId, url, caption, protect);
          else                               await tg.sendPhoto({ chatId, photo: url, caption, protectContent: protect });
        } else if (block.type === "audio" && url) {
          await tg.sendAudio(chatId, url, caption, protect);
        } else if (text) {
          await tg.sendMessage({ chatId, text: escapeHtml(interpolate(text, vars)), protectContent: protect });
        }
      }
    } else {
      const text = (c.message ?? c.text) as string | undefined;
      if (typeof text === "string" && text) {
        await tg.sendMessage({ chatId, text: escapeHtml(interpolate(text, vars)), protectContent: protect });
      }
    }
  }

  private async executeMediaNode(
    c:       Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
  ): Promise<void> {
    // Nó de mídia: { url, media_type, caption, extra_items[] }. Só o item
    // principal tem caption; os extras (álbum) são enviados em sequência.
    const main   = { url: c.url, media_type: c.media_type, caption: c.caption } as Record<string, unknown>;
    const extras = (c.extra_items as Array<Record<string, unknown>>) ?? [];
    const items  = [main, ...extras];

    for (const it of items) {
      const url = it.url as string | undefined;
      if (!url) continue;
      const caption   = typeof it.caption === "string" ? escapeHtml(interpolate(it.caption, vars)) : undefined;
      const mediaType = it.media_type as string | undefined;
      if (mediaType === "video")         await tg.sendVideo(chatId, url, caption, protect);
      else if (mediaType === "document") await tg.sendDocument(chatId, url, caption, protect);
      else                               await tg.sendPhoto({ chatId, photo: url, caption, protectContent: protect });
    }
  }

  private async executeButtonsNode(
    c:       Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
  ): Promise<void> {
    // Frontend salva o texto em `message` e os botões como { text, callback, action };
    // fallback p/ `text`/`label`/`value` antigos.
    const raw     = (c.message ?? c.text) as string | undefined;
    const text    = typeof raw === "string" && raw ? escapeHtml(interpolate(raw, vars)) : "Escolha uma opção:";
    const buttons = (c.buttons as Array<Record<string, unknown>>) ?? [];
    const keyboard = buttons.map((b) => {
      const label = (b.text ?? b.label ?? "") as string;
      if (typeof b.url === "string" && b.url) return [{ text: label, url: b.url }];
      return [{ text: label, callback_data: (b.callback ?? b.value ?? "") as string }];
    });
    await tg.sendMessage({
      chatId,
      text,
      protectContent: protect,
      replyMarkup: { inline_keyboard: keyboard },
    });
  }

  private async executeOfferNode(
    c:       Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
  ): Promise<void> {
    const offers = (c.offers as Array<{ product_name?: string; price?: number; payment_url?: string }>) ?? [];
    if (offers.length === 0) return;
    const offer = offers[0];
    const priceText = offer.price ? ` — R$ ${(offer.price / 100).toFixed(2)}` : "";
    const text = `*${offer.product_name ?? "Oferta"}*${priceText}`;
    const buttons = offer.payment_url
      ? [[{ text: "Comprar agora", url: offer.payment_url }]]
      : [];
    await tg.sendMessage({
      chatId,
      text: interpolate(text, vars),
      parseMode: "Markdown",
      protectContent: protect,
      replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
    });
  }
}
