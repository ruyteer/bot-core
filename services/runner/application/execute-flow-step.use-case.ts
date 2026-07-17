import { eq, and, ne, desc } from "drizzle-orm";
import { db } from "../../shared/database.js";
import {
  leads, leadProgress, leadVariables, leadMessages,
  funnels, funnelNodes, nodeConnections, scheduledDelays, bots, botGroups,
  funnelOffers,
} from "../../shared/schema/index.js";
import { TelegramClient } from "./telegram.client.js";
import { decrypt } from "../../shared/crypto.js";
import { interpolate, mergeLeadFields } from "./interpolate.js";
import type { TelegramUpdate, TelegramChatMemberUpdated } from "../../shared/events/index.js";
// Geração de PIX / persistência de cobrança vivem em `payments`, mas são código
// puro (fetch + repositórios sobre o `db` compartilhado), sem recursos Encore —
// importáveis aqui sem cruzar a fronteira de serviço.
import { GatewayDrizzleRepository } from "../../payments/infrastructure/gateway.drizzle.repository.js";
import { PaymentDrizzleRepository } from "../../payments/infrastructure/payment.drizzle.repository.js";
import { createPix } from "../../payments/application/gateway-clients.js";
import { encoreExternalUrl } from "../../config/secrets.js";
import type { Payment } from "../../payments/domain/payment.entity.js";
import { ExecuteSimplifiedFunnelUseCase } from "./execute-simplified-funnel.use-case.js";

const gwRepo  = new GatewayDrizzleRepository();
const payRepo = new PaymentDrizzleRepository();
const simplifiedUseCase = new ExecuteSimplifiedFunnelUseCase();

// Handle de uma oferta dentro de um nó `offer`. O frontend usa exatamente
// `offer.callback || offer.product_name || offer_<i>` como id dos conectores
// (`<handle>__paid|__pending|__no_action`) — replicamos para casar na retomada.
function offerHandleId(offer: Record<string, unknown>, i: number): string {
  const callback = typeof offer.callback === "string" ? offer.callback : "";
  const name     = typeof offer.product_name === "string" ? offer.product_name : "";
  return callback || name || `offer_${i}`;
}

// Coleta as ofertas "compráveis" de um nó com o handleId EXATO que o frontend usa
// nos conectores (`<handleId>__paid|__pending|__no_action`). Cobre o nó `offer`
// dedicado (content.offers) e blocos de oferta dentro de um nó `message`
// (blocks[].offers, cujo fallback de handle é `offer_<blockIdx>_<offerIdx>`).
// A ordem do retorno é o índice usado no callback `offer:<i>`.
function collectNodeOffers(content: Record<string, unknown>): Array<{ offer: Record<string, unknown>; handleId: string }> {
  const out: Array<{ offer: Record<string, unknown>; handleId: string }> = [];
  const direct = content.offers as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(direct)) {
    direct.forEach((offer, i) => out.push({ offer, handleId: offerHandleId(offer, i) }));
  }
  const blocks = content.blocks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(blocks)) {
    blocks.forEach((block, blockIdx) => {
      if (block.type !== "offer") return;
      const offers = block.offers as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(offers)) return;
      offers.forEach((offer, offerIdx) => {
        const callback = typeof offer.callback === "string" ? offer.callback : "";
        const name     = typeof offer.product_name === "string" ? offer.product_name : "";
        out.push({ offer, handleId: callback || name || `offer_${blockIdx}_${offerIdx}` });
      });
    });
  }
  return out;
}

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

// ── Validação de input ─────────────────────────────────────────────────────────
// O frontend (NodeEditPanel) salva `content.validation` com os valores:
// "none" | "email" | "number" | "cpf". Tratamos também sinônimos (numeric,
// telefone/phone, etc.) por segurança. Qualquer valor desconhecido → sem validação.

// Remove acentos e normaliza p/ comparação case-insensitive.
function normalizeValidationKind(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function isValidNumber(s: string): boolean {
  // inteiro ou decimal com . ou , (opcionalmente com sinal)
  return /^[+-]?\d+([.,]\d+)?$/.test(s.trim());
}

function isValidPhone(s: string): boolean {
  // 10–13 dígitos, ignorando separadores comuns (+, -, espaços, parênteses)
  const digits = s.replace(/[^\d]/g, "");
  return digits.length >= 10 && digits.length <= 13;
}

function isValidCpf(s: string): boolean {
  const cpf = s.replace(/[^\d]/g, "");
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos os dígitos iguais

  const calcDigit = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(cpf[i], 10) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calcDigit(9) === parseInt(cpf[9], 10) && calcDigit(10) === parseInt(cpf[10], 10);
}

// Retorna true se `value` passa na validação `kind`. Tipos desconhecidos/none → true.
function passesValidation(kind: unknown, value: string): boolean {
  const k = normalizeValidationKind(kind);
  switch (k) {
    case "email":   return isValidEmail(value);
    case "number":
    case "numero":
    case "numeric": return isValidNumber(value);
    case "cpf":     return isValidCpf(value);
    case "telefone":
    case "phone":   return isValidPhone(value);
    default:        return true; // none/"" /desconhecido → sem validação
  }
}

async function getVars(leadId: string, botId: string): Promise<Map<string, string>> {
  const rows = await db.select().from(leadVariables)
    .where(and(eq(leadVariables.leadId, leadId), eq(leadVariables.botId, botId)));
  const map = new Map(rows.map((r) => [r.variableName, r.value]));
  // Injeta campos nativos do lead ({{first_name}}, {{username}}, ...) sem
  // sobrescrever variáveis já salvas pelo usuário.
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (lead) mergeLeadFields(map, lead);
  return map;
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

    // ── Bot adicionado/removido de grupo/canal (my_chat_member) ─────────────
    if (update.my_chat_member) {
      await this.handleChatMemberEvent(botId, update.my_chat_member);
      return;
    }

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
    const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatIdStr = chatId.toString();

    // ── Migração grupo→supergrupo: o chat ganha ID novo e o antigo morre.
    //    Remapeia o registro salvo para o ID novo (em vez de deixar os dois).
    if (update.message?.migrate_to_chat_id) {
      await this.handleGroupMigration(botId, BigInt(update.message.chat.id), BigInt(update.message.migrate_to_chat_id));
      return;
    }
    if (update.message?.migrate_from_chat_id) {
      await this.handleGroupMigration(botId, BigInt(update.message.migrate_from_chat_id), BigInt(update.message.chat.id));
      return;
    }

    // ── Mensagens em grupo/canal: `/id` salva o grupo e devolve o ID; as
    //    demais são ignoradas (nunca registrar um grupo como lead) ──────────
    const inboundChatType = update.message?.chat.type;
    if (inboundChatType && inboundChatType !== "private") {
      if (typeof messageText === "string" && messageText.trim().startsWith("/id")) {
        await this.handleIdCommand(botId, update.message!.chat.id, inboundChatType, tg);
      }
      return;
    }

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

    // ── Compra via botão de OFERTA de broadcast/remarketing (bcast_buy_<id>) ──
    if (callbackData && callbackData.startsWith("bcast_buy_")) {
      await this.handleBroadcastBuy(callbackData.slice("bcast_buy_".length), lead, bot, chatIdStr, tg);
      return;
    }

    // Check if lead is manually paused — drop all automation
    const [prog] = await db.select().from(leadProgress)
      .where(eq(leadProgress.leadId, lead.id));
    if (prog?.status === "paused_manual") return;

    const vars = await getVars(lead.id, botId);

    // ── Funil SIMPLIFICADO tem precedência (interpretador linear, stateless) ──
    const [simplifiedFunnel] = await db.select().from(funnels)
      .where(and(eq(funnels.botId, botId), eq(funnels.isActive, true), eq(funnels.kind, "simplified")))
      .orderBy(desc(funnels.updatedAt))
      .limit(1);
    if (simplifiedFunnel) {
      const handled = await simplifiedUseCase.handle({
        bot, lead, chatId: chatIdStr, funnel: simplifiedFunnel,
        text: messageText, callbackData,
        callbackMessageId: update.callback_query?.message?.message_id ?? null,
        tg,
      });
      if (handled) return;
    }

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

      // Clique num botão de compra (callback `offer:<i>`, curto p/ caber no limite
      // de 64 bytes do TG). Funciona no nó `offer` dedicado E em ofertas embutidas
      // num nó `message` — o índice é resolvido pela mesma ordem de collectNodeOffers.
      if (currentNode && callbackData.startsWith("offer:")) {
        const offersList = collectNodeOffers(currentNode.content as Record<string, unknown>);
        const idx = parseInt(callbackData.slice("offer:".length), 10);
        const picked = Number.isInteger(idx) ? offersList[idx] : undefined;
        if (picked) {
          await this.handleOfferPurchase(picked.offer, picked.handleId, currentNode, prog, lead, bot, chatIdStr, tg);
        }
        return;
      }

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
        const c = currentNode.content as {
          variable_name?: string;
          validation?:    string;
          error_message?: string;
        };

        // 1) Validação de input: se houver `validation` configurado e a resposta
        //    for inválida, reenvia a mensagem de erro e PERMANECE no nó (não salva
        //    variável nem avança). Sem validation (ou tipo desconhecido) → segue.
        if (!passesValidation(c.validation, messageText)) {
          const errRaw = c.error_message ?? "Resposta inválida. Tente novamente.";
          const errText = escapeHtml(interpolate(errRaw, vars));
          await tg.sendMessage({ chatId: chatIdStr, text: errText, protectContent: bot.protectContent });
          await saveOutbound(lead.id, botId, { kind: "text", text: errText, nodeId: currentNode.id });
          return; // fica no mesmo nó esperando nova resposta
        }

        if (c.variable_name) {
          await setVar(lead.id, botId, c.variable_name, messageText);
          vars.set(c.variable_name, messageText);
        }

        // 2) Resolução do próximo nó:
        //    - wait_response: cancela timeouts pendentes deste progresso e avança
        //      pelo handle "responded" (fallback p/ a conexão default).
        //    - input: comportamento atual (conexão default).
        let nextId: string | null;
        if (currentNode.type === "wait_response") {
          await db.delete(scheduledDelays).where(and(
            eq(scheduledDelays.progressId, prog.id),
            eq(scheduledDelays.status, "pending"),
          ));
          nextId = await nextNode(prog.funnelId, currentNode.id, "responded")
                ?? await nextNode(prog.funnelId, currentNode.id);
        } else {
          nextId = await nextNode(prog.funnelId, currentNode.id);
        }

        if (nextId) {
          await advanceProgress(prog.id, nextId, "active");
          await this.runNode(prog.funnelId, nextId, prog.id, lead.id, botId, chatIdStr, tg, bot.protectContent, vars, null);
        }
      }
    }
  }

  // ── Grupo/canal: bot virou (ou deixou de ser) membro/admin ──────────────────
  private async handleChatMemberEvent(botId: string, ev: TelegramChatMemberUpdated): Promise<void> {
    const status = ev.new_chat_member?.status;
    const isBot  = ev.new_chat_member?.user?.is_bot;
    const type   = ev.chat?.type;
    if (!isBot || (type !== "group" && type !== "supergroup" && type !== "channel")) return;

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot || !bot.isActive) return;
    const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatId = ev.chat.id;

    // Removido/saiu → remove do sistema.
    if (status === "left" || status === "kicked") {
      await db.delete(botGroups).where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, BigInt(chatId))));
      return;
    }

    // Só salva quando o bot vira ADMIN. Entrar como membro comum não registra:
    // além de inútil pra VIP (sem permissão de convite), adicionar como membro
    // e promover depois gerava registro duplicado quando o Telegram migrava o
    // grupo básico para supergrupo (id novo).
    if (status === "administrator") {
      const isChannel = type === "channel";
      const label = isChannel ? "Canal" : "Grupo";
      const info = await tg.getChat(String(chatId));
      const name = info?.title || label;
      await this.upsertGroup(botId, BigInt(chatId), name, type);

      const permissionNote = isChannel
        ? `permissão de "<b>Postar mensagens</b>"`
        : `permissão de "<b>Banir usuários</b>"`;
      const msg = `✅ <b>Bot adicionado com sucesso!</b>\n\nPara usar este ${label.toLowerCase()} como ${label.toLowerCase()} VIP:\n\n1️⃣ Certifique-se de que o bot tem ${permissionNote}\n2️⃣ No painel, vá em <b>Produtos</b> e crie um produto do tipo "<b>${label} VIP</b>"\n3️⃣ Cole o ID no campo "ID do Grupo Telegram"\n\n🆔 <b>ID deste ${label.toLowerCase()}:</b> <code>${chatId}</code>`;
      await tg.sendMessage({ chatId: String(chatId), text: msg, protectContent: false }).catch(() => {});
    }
  }

  // ── Comando `/id` em grupo/canal: salva e devolve o ID ──────────────────────
  private async handleIdCommand(botId: string, chatId: number, type: string, tg: TelegramClient): Promise<void> {
    const label = type === "channel" ? "Canal" : "Grupo";
    const info  = await tg.getChat(String(chatId));
    const name  = info?.title || label;
    await this.upsertGroup(botId, BigInt(chatId), name, type);
    const msg = `🆔 <b>ID deste ${label.toLowerCase()}:</b> <code>${chatId}</code>\n\n✅ ${label} salvo automaticamente no painel.`;
    await tg.sendMessage({ chatId: String(chatId), text: msg, protectContent: false }).catch(() => {});
  }

  // Migração grupo→supergrupo: atualiza o registro antigo IN-PLACE para o id
  // novo (preserva o uuid da linha — ofertas VIP que referenciam bot_groups.id
  // continuam válidas). Se o supergrupo já foi salvo em outra linha, funde as
  // duas mantendo a antiga.
  private async handleGroupMigration(botId: string, oldChatId: bigint, newChatId: bigint): Promise<void> {
    const [oldRow] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, oldChatId)));
    const [newRow] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, newChatId)));

    if (!oldRow) return; // nada salvo com o id antigo — nada a remapear

    let name = oldRow.name;
    if (newRow) {
      // Funde: repoint das ofertas que apontam pra linha nova → linha antiga,
      // apaga a duplicada e herda o nome mais recente.
      await db.update(funnelOffers).set({ telegramGroupId: oldRow.id })
        .where(eq(funnelOffers.telegramGroupId, newRow.id));
      await db.delete(botGroups).where(eq(botGroups.id, newRow.id));
      name = newRow.name;
    }

    await db.update(botGroups)
      .set({ telegramChatId: newChatId, type: "supergroup", name, updatedAt: new Date() })
      .where(eq(botGroups.id, oldRow.id));
    console.log(`[runner] grupo migrado p/ supergrupo: ${oldChatId} → ${newChatId} (bot ${botId})`);
  }

  // Upsert de grupo por (botId, telegramChatId) — sem depender de constraint única.
  private async upsertGroup(botId: string, chatId: bigint, name: string, type: string): Promise<void> {
    const [existing] = await db.select().from(botGroups)
      .where(and(eq(botGroups.botId, botId), eq(botGroups.telegramChatId, chatId)));
    if (existing) {
      await db.update(botGroups).set({ name, type, updatedAt: new Date() }).where(eq(botGroups.id, existing.id));
    } else {
      await db.insert(botGroups).values({ botId, telegramChatId: chatId, name, type });
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
      case "message": {
        await this.executeMessageNode(c, chatId, tg, protect, vars);
        await saveOutbound(leadId, botId, { ...c, nodeId: node.id });
        // Nó de mensagem pode conter blocos de oferta (botões de compra). Se houver,
        // comporta-se como nó offer: apresenta as ofertas, espera o clique e agenda
        // o ramo __no_action — não avança automaticamente.
        const msgOffers = collectNodeOffers(c);
        if (msgOffers.length > 0) {
          await this.presentOffers(c, msgOffers, chatId, tg, protect, vars);
          await advanceProgress(progressId, node.id, "active");
          await this.scheduleOfferTimeouts(funnelId, node, progressId, leadId, botId, "__no_action");
          return;
        }
        break;
      }

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

        // Timeout do wait_response: o frontend salva `timeout_seconds` (em segundos)
        // e liga o nó pelos handles "responded" e "no_response". Se houver timeout
        // e um alvo no_response, agenda em scheduled_delays p/ o scheduler existente
        // (runner.ts) rodar o ramo no_response quando vencer. Sem timeout ou sem
        // alvo → não agenda (espera indefinidamente, como antes).
        if (node.type === "wait_response") {
          const timeoutSeconds = typeof c.timeout_seconds === "number" ? c.timeout_seconds : 0;
          if (timeoutSeconds > 0) {
            const noResponseId = await nextNode(funnelId, node.id, "no_response");
            if (noResponseId) {
              await db.insert(scheduledDelays).values({
                botId,
                leadId,
                funnelId,
                progressId,
                nextNodeId: noResponseId,
                executeAt:  new Date(Date.now() + timeoutSeconds * 1000),
                status:     "pending",
              });
            }
          }
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
        if (connections.length === 0) return;

        // Frontend salva `content.outputs` = [{ name, weight, handle }], onde handle
        // é "out_0", "out_1", ... e os weights somam ~100. Escolha PONDERADA pelos
        // weights; fallback p/ escolha uniforme entre as conexões quando não houver
        // outputs/weights válidos.
        const outputs = (c.outputs as Array<{ weight?: number; handle?: string }>) ?? [];
        const valid   = outputs.filter((o) => typeof o.handle === "string" && (o.weight ?? 0) > 0);
        const total   = valid.reduce((sum, o) => sum + (o.weight ?? 0), 0);

        let targetId: string | null = null;
        if (valid.length > 0 && total > 0) {
          let r = Math.random() * total;
          let chosenHandle = valid[valid.length - 1].handle!; // fallback p/ último
          for (const o of valid) {
            r -= o.weight ?? 0;
            if (r < 0) { chosenHandle = o.handle!; break; }
          }
          targetId = connections.find((cn) => cn.sourceHandle === chosenHandle)?.targetNodeId
                  ?? await nextNode(funnelId, node.id, chosenHandle);
        }

        // Fallback uniforme se a ponderação não resolveu um alvo conectado.
        if (!targetId) {
          targetId = connections[Math.floor(Math.random() * connections.length)].targetNodeId;
        }

        await this.runNode(funnelId, targetId, progressId, leadId, botId, chatId, tg, protect, vars, node.id, depth + 1);
        return;
      }

      case "offer":
        // Offer node sends a message and waits for payment — no automation advance here
        await this.executeOfferNode(c, chatId, tg, protect, vars);
        await saveOutbound(leadId, botId, { ...c, kind: "offer", nodeId: node.id });
        await advanceProgress(progressId, node.id, "active");
        // Se o lead nunca clicar em comprar, dispara o ramo __no_action após o
        // unpaid_timeout. Cancelado quando ele clica (handleOfferPurchase).
        await this.scheduleOfferTimeouts(funnelId, node, progressId, leadId, botId, "__no_action");
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
        // "digitando…"/"gravando áudio…" antes de enviar o bloco (cosmético, auto-expira ~5s).
        if (block.simulate_typing)         await tg.sendChatAction(chatId, "typing");
        else if (block.simulate_recording) await tg.sendChatAction(chatId, "record_voice");

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
    // Nó de mídia: { url, media_type, caption, extra_items[] }. Com 2+ itens de
    // imagem/vídeo, envia como ÁLBUM (sendMediaGroup) — o Telegram agrupa numa só
    // mensagem. Documentos/áudios não entram em álbum e vão individualmente.
    // O caption (HTML) vai só no 1º item do álbum (limite do Telegram).
    const main   = { url: c.url, media_type: c.media_type, caption: c.caption } as Record<string, unknown>;
    const extras = (c.extra_items as Array<Record<string, unknown>>) ?? [];
    const items  = [main, ...extras].filter((it) => typeof it.url === "string" && it.url);

    const capOf  = (it: Record<string, unknown>): string | undefined =>
      typeof it.caption === "string" ? escapeHtml(interpolate(it.caption, vars)) : undefined;
    const typeOf = (it: Record<string, unknown>): string => (it.media_type as string) || "image";
    const isAlbumType = (t: string): boolean => t === "image" || t === "photo" || t === "video";

    const single = (it: Record<string, unknown>): Promise<void> => {
      const url = it.url as string;
      const caption = capOf(it);
      const t = typeOf(it);
      if (t === "video")    return tg.sendVideo(chatId, url, caption, protect);
      if (t === "document") return tg.sendDocument(chatId, url, caption, protect);
      if (t === "audio")    return tg.sendAudio(chatId, url, caption, protect);
      return tg.sendPhoto({ chatId, photo: url, caption, protectContent: protect });
    };

    const albumItems = items.filter((it) => isAlbumType(typeOf(it)));
    if (albumItems.length >= 2) {
      try {
        await tg.sendMediaGroup(
          chatId,
          albumItems.map((it, i) => ({
            type:    typeOf(it) === "video" ? "video" as const : "photo" as const,
            media:   it.url as string,
            caption: i === 0 ? capOf(it) : undefined,
          })),
          protect,
        );
      } catch {
        for (const it of albumItems) await single(it);
      }
      for (const it of items) if (!isAlbumType(typeOf(it))) await single(it);
      return;
    }

    for (const it of items) await single(it);
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
    const offersList = collectNodeOffers(c);
    if (offersList.length === 0) return;
    await this.presentOffers(c, offersList, chatId, tg, protect, vars);
  }

  // Renderiza um botão de compra por oferta (callback `offer:<i>`, na ordem de
  // collectNodeOffers). Texto/imagem vêm de intro_message + 1ª oferta.
  private async presentOffers(
    content:    Record<string, unknown>,
    offersList: Array<{ offer: Record<string, unknown>; handleId: string }>,
    chatId:     string,
    tg:         TelegramClient,
    protect:    boolean,
    vars:       Map<string, string>,
  ): Promise<void> {
    const keyboard = offersList.map(({ offer }, i) => {
      // price vem do nó do funil em REAIS (MoneyInput no front emite reais).
      const price = typeof offer.price === "number" ? offer.price : 0;
      const label = (typeof offer.button_text === "string" && offer.button_text)
        ? offer.button_text
        : `Comprar — R$ ${price.toFixed(2)}`;
      return [{ text: label, callback_data: `offer:${i}` }];
    });

    const intro = typeof content.intro_message === "string" && content.intro_message
      ? escapeHtml(interpolate(content.intro_message, vars))
      : null;
    const first = offersList[0].offer;
    const firstName = typeof first.product_name === "string" ? first.product_name : "";
    const caption = intro ?? (firstName ? escapeHtml(interpolate(firstName, vars)) : "Escolha uma oferta:");
    const image = typeof first.image_url === "string" ? first.image_url : "";

    if (image) {
      await tg.sendPhoto({ chatId, photo: image, caption, protectContent: protect, replyMarkup: { inline_keyboard: keyboard } });
    } else {
      await tg.sendMessage({ chatId, text: caption, protectContent: protect, replyMarkup: { inline_keyboard: keyboard } });
    }
  }

  // ── Agenda timeouts de oferta (__no_action ao apresentar, __pending após PIX) ─
  // Usa `unpaid_timeout` (minutos, default 5, mín. 60s) do conteúdo do nó. Agenda
  // um delay por oferta cujo handle (`<handleId>__no_action|__pending`) tenha
  // conexão. Para __pending, só a oferta `onlyHandleId` (a que o lead clicou).
  private async scheduleOfferTimeouts(
    funnelId:     string,
    node:         typeof funnelNodes.$inferSelect,
    progressId:   string,
    leadId:       string,
    botId:        string,
    suffix:       "__no_action" | "__pending",
    onlyHandleId?: string,
  ): Promise<void> {
    const content = node.content as Record<string, unknown> & { unpaid_timeout?: number };
    const offersList = collectNodeOffers(content);
    const timeoutMin = typeof content.unpaid_timeout === "number" && content.unpaid_timeout > 0 ? content.unpaid_timeout : 5;
    const executeAt  = new Date(Date.now() + Math.max(60, timeoutMin * 60) * 1000);

    for (const { handleId } of offersList) {
      if (onlyHandleId !== undefined && handleId !== onlyHandleId) continue;
      const target = await nextNode(funnelId, node.id, `${handleId}${suffix}`);
      if (!target) continue;
      await db.insert(scheduledDelays).values({
        botId, leadId, funnelId, progressId, nextNodeId: target, executeAt, status: "pending",
      });
    }
  }

  // ── Compra: gera PIX, persiste a cobrança e envia copia-e-cola + QR ──────────
  private async handleOfferPurchase(
    offer:  Record<string, unknown>,
    handleId: string,
    node:   typeof funnelNodes.$inferSelect,
    prog:   typeof leadProgress.$inferSelect,
    lead:   typeof leads.$inferSelect,
    bot:    typeof bots.$inferSelect,
    chatId: string,
    tg:     TelegramClient,
  ): Promise<void> {
    // O lead interagiu com a oferta → cancela os timeouts __no_action pendentes
    // deste progresso (só há os do nó de oferta atual).
    await db.delete(scheduledDelays).where(and(
      eq(scheduledDelays.progressId, prog.id),
      eq(scheduledDelays.status, "pending"),
    ));

    const gatewayId = typeof offer.gateway_id === "string" ? offer.gateway_id : "";
    // offer.price está em REAIS no nó do funil; gateway e tabela payments usam centavos.
    const amount    = typeof offer.price === "number" ? Math.round(offer.price * 100) : 0;
    const productName = (typeof offer.product_name === "string" && offer.product_name) ? offer.product_name : "Produto";

    if (amount <= 0) {
      await tg.sendMessage({ chatId, text: "Oferta indisponível no momento.", protectContent: bot.protectContent });
      return;
    }

    const gw = await gwRepo.findForBot({ userId: bot.userId, defaultGatewayId: bot.defaultGatewayId, explicitGatewayId: gatewayId || null });
    if (!gw) {
      await tg.sendMessage({ chatId, text: "Gateway de pagamento não configurado.", protectContent: bot.protectContent });
      return;
    }

    const { clientId, clientSecret } = gwRepo.decryptCredentials(gw);
    const webhookUrl = `${encoreExternalUrl()}/payments/webhook/${gw.provider}`;

    let pix;
    try {
      pix = await createPix(gw.provider, clientId, clientSecret, amount, productName, webhookUrl);
    } catch (err) {
      console.error("[runner] createPix falhou:", err);
      await tg.sendMessage({ chatId, text: "Não consegui gerar o PIX agora. Tente novamente em instantes.", protectContent: bot.protectContent });
      return;
    }

    // Persiste a cobrança com o contexto p/ retomar o funil quando pago.
    await payRepo.create({
      userId:      bot.userId,
      botId:       bot.id,
      leadId:      lead.id,
      gatewayId:   gw.id,
      offerName:   productName,
      amount,
      status:      "pending",
      externalId:  pix.externalId,
      pixCode:     pix.pixCode,
      description: productName,
      funnelId:    prog.funnelId,
      progressId:  prog.id,
      nodeId:      node.id,
      paidHandle:  `${handleId}__paid`,
    });

    // Gerou PIX e não pagou → dispara o ramo __pending após o unpaid_timeout.
    // Cancelado quando o pagamento confirma (handlePaidOffer).
    await this.scheduleOfferTimeouts(prog.funnelId, node, prog.id, lead.id, bot.id, "__pending", handleId);

    const caption = `💠 <b>${escapeHtml(productName)}</b>\nValor: R$ ${(amount / 100).toFixed(2)}\n\nPague com o PIX copia-e-cola abaixo 👇`;
    await tg.sendPhoto({ chatId, photo: pix.qrImage, caption, protectContent: bot.protectContent });
    await tg.sendMessage({ chatId, text: `<code>${escapeHtml(pix.pixCode)}</code>`, protectContent: bot.protectContent });
    await saveOutbound(lead.id, bot.id, { kind: "offer_pix", offerName: productName, externalId: pix.externalId, nodeId: node.id });
  }

  // ── Compra avulsa de oferta (botão de broadcast/remarketing) → gera PIX ──────
  private async handleBroadcastBuy(
    offerId: string,
    lead: typeof leads.$inferSelect,
    bot:  typeof bots.$inferSelect,
    chatId: string,
    tg:   TelegramClient,
  ): Promise<void> {
    const [offer] = await db.select().from(funnelOffers)
      .where(and(eq(funnelOffers.id, offerId), eq(funnelOffers.botId, bot.id)));
    if (!offer) { await tg.sendMessage({ chatId, text: "⚠️ Produto não encontrado.", protectContent: bot.protectContent }); return; }

    const amount = offer.price; // funnel_offers.price já é em centavos
    if (amount <= 0) { await tg.sendMessage({ chatId, text: "Oferta indisponível no momento.", protectContent: bot.protectContent }); return; }

    const gw = await gwRepo.findForBot({ userId: bot.userId, defaultGatewayId: bot.defaultGatewayId });
    if (!gw) { await tg.sendMessage({ chatId, text: "⚠️ Gateway de pagamento não configurado.", protectContent: bot.protectContent }); return; }
    const { clientId, clientSecret } = gwRepo.decryptCredentials(gw);
    const webhookUrl = `${encoreExternalUrl()}/payments/webhook/${gw.provider}`;

    let pix;
    try {
      pix = await createPix(gw.provider, clientId, clientSecret, amount, offer.name, webhookUrl);
    } catch (err) {
      console.error("[runner] bcast_buy createPix falhou:", err);
      await tg.sendMessage({ chatId, text: "Não consegui gerar o PIX agora. Tente novamente em instantes.", protectContent: bot.protectContent });
      return;
    }

    await payRepo.create({
      userId: bot.userId, botId: bot.id, leadId: lead.id, gatewayId: gw.id,
      offerId: offer.id, offerName: offer.name, amount, status: "pending",
      externalId: pix.externalId, pixCode: pix.pixCode, description: offer.name,
    });

    const caption = `💠 <b>${escapeHtml(offer.name)}</b>\nValor: R$ ${(amount / 100).toFixed(2)}\n\nPague com o PIX copia-e-cola abaixo 👇`;
    await tg.sendPhoto({ chatId, photo: pix.qrImage, caption, protectContent: bot.protectContent });
    await tg.sendMessage({ chatId, text: `<code>${escapeHtml(pix.pixCode)}</code>`, protectContent: bot.protectContent });
  }

  // ── Entrega do produto de uma oferta avulsa (funnel_offers) após pagamento ───
  private async deliverFunnelOffer(payment: Payment): Promise<void> {
    if (!payment.offerId || !payment.leadId) return;
    const [offer] = await db.select().from(funnelOffers).where(eq(funnelOffers.id, payment.offerId));
    const [bot]   = await db.select().from(bots).where(eq(bots.id, payment.botId));
    const [lead]  = await db.select().from(leads).where(eq(leads.id, payment.leadId));
    if (!offer || !bot || !lead) return;
    const tg = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatId = lead.telegramChatId.toString();

    if (offer.productType === "vip_group" && offer.telegramGroupId) {
      const [grp] = await db.select().from(botGroups).where(eq(botGroups.id, offer.telegramGroupId));
      if (grp) {
        const expireDate = offer.accessDays > 0 ? Math.floor(Date.now() / 1000) + offer.accessDays * 86400 : undefined;
        try {
          const link = await tg.createChatInviteLink(grp.telegramChatId.toString(), { memberLimit: 1, expireDate });
          await tg.sendMessage({ chatId, text: `✅ Pagamento confirmado! Seu acesso: ${link}`, protectContent: bot.protectContent });
          return;
        } catch (e) { console.error("[runner] deliverFunnelOffer invite:", e); }
      }
      await tg.sendMessage({ chatId, text: "✅ Pagamento confirmado! Em instantes você recebe o acesso.", protectContent: bot.protectContent });
      return;
    }
    if (offer.productType === "text" && offer.deliveryText) {
      await tg.sendMessage({ chatId, text: `✅ Pagamento confirmado!\n\n${offer.deliveryText}`, protectContent: bot.protectContent });
      return;
    }
    const url = offer.deliveryUrl ?? "";
    await tg.sendMessage({ chatId, text: url ? `✅ Pagamento confirmado! Acesse seu produto: ${url}` : "✅ Pagamento confirmado!", protectContent: bot.protectContent });
  }

  // ── Pago (chamado pela subscription do webhook): entrega + retoma o funil ────
  async handlePaidOffer(payment: Payment): Promise<void> {
    // Compra avulsa (oferta de broadcast/remarketing): sem contexto de funil, mas
    // com offerId → entrega o produto direto e encerra.
    if ((!payment.progressId || !payment.nodeId || !payment.paidHandle || !payment.funnelId) && payment.offerId) {
      await this.deliverFunnelOffer(payment).catch((e) => console.error("[runner] deliverFunnelOffer falhou:", e));
      return;
    }
    if (!payment.progressId || !payment.nodeId || !payment.paidHandle || !payment.funnelId || !payment.leadId) {
      return; // cobrança sem contexto de funil (ex.: teste de gateway) — ignora
    }

    const [prog] = await db.select().from(leadProgress).where(eq(leadProgress.id, payment.progressId));
    const [lead] = await db.select().from(leads).where(eq(leads.id, payment.leadId));
    const [bot]  = await db.select().from(bots).where(eq(bots.id, payment.botId));
    const [node] = await db.select().from(funnelNodes).where(eq(funnelNodes.id, payment.nodeId));
    if (!prog || !lead || !bot || !node) return;

    const tg     = new TelegramClient(decrypt(bot.telegramToken), bot.id);
    const chatId = lead.telegramChatId.toString();
    const vars   = await getVars(lead.id, bot.id);

    // Pagou → cancela o timeout __pending pendente deste progresso.
    await db.delete(scheduledDelays).where(and(
      eq(scheduledDelays.progressId, payment.progressId),
      eq(scheduledDelays.status, "pending"),
    ));

    // Localiza a oferta paga p/ entregar o produto (handle sem o sufixo __paid).
    // collectNodeOffers cobre tanto o nó offer quanto ofertas embutidas em message.
    const handleId = payment.paidHandle.replace(/__paid$/, "");
    const offer    = collectNodeOffers(node.content as Record<string, unknown>)
      .find((x) => x.handleId === handleId)?.offer;
    if (offer) {
      await this.deliverOffer(offer, chatId, tg, bot.protectContent, vars)
        .catch((e) => console.error("[runner] entrega da oferta falhou:", e));
    }

    // Retoma o funil pelo ramo __paid.
    const nextId = await nextNode(payment.funnelId, payment.nodeId, payment.paidHandle);
    if (nextId) {
      await advanceProgress(prog.id, nextId, "active");
      await this.runNode(payment.funnelId, nextId, prog.id, lead.id, bot.id, chatId, tg, bot.protectContent, vars, null);
    } else {
      await advanceProgress(prog.id, null, "completed");
    }
  }

  // Entrega do produto pago: link de conteúdo ou convite de grupo VIP.
  private async deliverOffer(
    offer:   Record<string, unknown>,
    chatId:  string,
    tg:      TelegramClient,
    protect: boolean,
    vars:    Map<string, string>,
  ): Promise<void> {
    const type = typeof offer.product_type === "string" ? offer.product_type : "content";

    if (type === "vip_group") {
      const groupId = (typeof offer.telegram_group_id === "string" ? offer.telegram_group_id : "").trim();
      if (!groupId) return;
      const accessDays = typeof offer.access_days === "number" ? offer.access_days : 0;
      const expireDate = accessDays > 0 ? Math.floor(Date.now() / 1000) + accessDays * 86400 : undefined;
      try {
        const link = await tg.createChatInviteLink(groupId, { memberLimit: 1, expireDate });
        await tg.sendMessage({ chatId, text: `✅ Pagamento confirmado! Seu acesso: ${link}`, protectContent: protect });
      } catch (err) {
        console.error("[runner] createChatInviteLink falhou:", err);
        await tg.sendMessage({ chatId, text: "✅ Pagamento confirmado! Em instantes você recebe o acesso.", protectContent: protect });
      }
      return;
    }

    const url = typeof offer.delivery_url === "string" ? offer.delivery_url : "";
    const text = url
      ? `✅ Pagamento confirmado! Acesse seu produto: ${escapeHtml(interpolate(url, vars))}`
      : "✅ Pagamento confirmado!";
    await tg.sendMessage({ chatId, text, protectContent: protect });
  }
}
