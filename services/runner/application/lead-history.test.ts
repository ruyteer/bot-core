// Registro do histórico do lead: antes só texto enviado pelo lead virava
// mensagem em `lead_messages` — foto, vídeo, áudio/voz, documento, figurinha,
// contato, localização e clique em botão nunca eram gravados, e o conteúdo
// enviado PELO funil (saveOutbound) não carregava `kind` explícito. Ver
// `inboundContentFromMessage`, `describeInboundButtonClick` e os `saveOutbound`
// dos nós message/media/buttons em `execute-flow-step.use-case.ts`.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import {
  createBot, createFlowFunnel, startUpdate, callbackUpdate, createLead,
} from "../../../test/helpers/seed.js";
import { testDb } from "../../../test/helpers/db.js";
import { leadMessages, leads } from "../../shared/schema/index.js";
import type { TelegramUpdate } from "../../shared/events/index.js";

const useCase = new ExecuteFlowStepUseCase();

async function messagesFor(leadId: string): Promise<Array<{ direction: string; content: Record<string, unknown> }>> {
  const db = await testDb();
  const rows = await db.select().from(leadMessages).where(eq(leadMessages.leadId, leadId)).orderBy(leadMessages.createdAt);
  return rows.map((r) => ({ direction: r.direction, content: r.content as Record<string, unknown> }));
}

// O lead é criado pelo próprio upsert do runner (não existe antes do /start ou
// do primeiro callback), então alguns testes precisam achar o id gerado pelo
// chatId do Telegram usado no update.
async function leadIdByChat(chatId: bigint): Promise<string> {
  const db = await testDb();
  const [row] = await db.select().from(leads).where(eq(leads.telegramChatId, chatId));
  return row.id;
}

let updateId = 90_000;

// Builders de update com anexo — `textUpdate`/`callbackUpdate` (test/helpers/seed.ts)
// só cobrem texto e callback; os demais tipos de anexo do Telegram não tinham
// nenhum uso em teste até esta correção.
function attachmentUpdate(chatId: number, attachment: Record<string, unknown>): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: "private" },
      from: { id: chatId, first_name: "Lead" },
      date: Math.floor(Date.now() / 1000),
      ...attachment,
    },
  };
}

describe("registro do histórico — inbound (o que o lead faz)", () => {
  it("foto: grava kind=photo com fileId e caption", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2001n);
    await useCase.execute({
      botId: bot.id,
      update: attachmentUpdate(2001, { photo: [{ file_id: "small" }, { file_id: "big" }], caption: "olha isso" }),
    });
    const [msg] = await messagesFor(leadId);
    expect(msg.direction).toBe("inbound");
    expect(msg.content).toMatchObject({ kind: "photo", fileId: "big", caption: "olha isso" });
  });

  it("vídeo: grava kind=video com fileId", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2002n);
    await useCase.execute({ botId: bot.id, update: attachmentUpdate(2002, { video: { file_id: "vid1" } }) });
    const [msg] = await messagesFor(leadId);
    expect(msg.content).toMatchObject({ kind: "video", fileId: "vid1" });
  });

  it("áudio de voz (voice): grava kind=voice", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2003n);
    await useCase.execute({ botId: bot.id, update: attachmentUpdate(2003, { voice: { file_id: "voice1" } }) });
    const [msg] = await messagesFor(leadId);
    expect(msg.content).toMatchObject({ kind: "voice", fileId: "voice1" });
  });

  it("áudio (música): grava kind=audio", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2004n);
    await useCase.execute({ botId: bot.id, update: attachmentUpdate(2004, { audio: { file_id: "audio1" } }) });
    const [msg] = await messagesFor(leadId);
    expect(msg.content).toMatchObject({ kind: "audio", fileId: "audio1" });
  });

  it("documento: grava kind=document com fileId e fileName", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2005n);
    await useCase.execute({
      botId: bot.id,
      update: attachmentUpdate(2005, { document: { file_id: "doc1", file_name: "contrato.pdf" } }),
    });
    const [msg] = await messagesFor(leadId);
    expect(msg.content).toMatchObject({ kind: "document", fileId: "doc1", fileName: "contrato.pdf" });
  });

  it("figurinha: grava kind=sticker com fileId e emoji", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2006n);
    await useCase.execute({ botId: bot.id, update: attachmentUpdate(2006, { sticker: { file_id: "sticker1", emoji: "👍" } }) });
    const [msg] = await messagesFor(leadId);
    expect(msg.content).toMatchObject({ kind: "sticker", fileId: "sticker1", emoji: "👍" });
  });

  it("contato: grava kind=contact com telefone e nome", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2007n);
    await useCase.execute({
      botId: bot.id,
      update: attachmentUpdate(2007, { contact: { phone_number: "+5511999999999", first_name: "João" } }),
    });
    const [msg] = await messagesFor(leadId);
    expect(msg.content).toMatchObject({ kind: "contact", phoneNumber: "+5511999999999", firstName: "João" });
  });

  it("localização: grava kind=location com latitude e longitude", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2008n);
    await useCase.execute({ botId: bot.id, update: attachmentUpdate(2008, { location: { latitude: -23.5, longitude: -46.6 } }) });
    const [msg] = await messagesFor(leadId);
    expect(msg.content).toMatchObject({ kind: "location", latitude: -23.5, longitude: -46.6 });
  });

  it("clique em botão do nó `buttons`: grava kind=button_click com rótulo e callbackData", async () => {
    const bot = await createBot();
    const { nodeIds } = await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "btn", type: "buttons", content: { message: "Escolha:", buttons: [{ text: "Sim, quero", callback: "opt_a" }] } },
        { key: "done", type: "message", content: { message: "Você escolheu" } },
      ],
      connections: [
        { from: "trigger", to: "btn" },
        { from: "btn", to: "done", handle: "opt_a" },
      ],
    });

    await useCase.execute({ botId: bot.id, update: startUpdate(2009) });
    const scope = nodeIds.btn.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    await useCase.execute({ botId: bot.id, update: callbackUpdate(2009, `b:${scope}:0`) });

    const leadId = await leadIdByChat(2009n);
    const msgs = await messagesFor(leadId);
    const click = msgs.find((m) => (m.content as Record<string, unknown>).kind === "button_click");
    expect(click).toBeDefined();
    expect(click!.content).toMatchObject({ kind: "button_click", callbackData: `b:${scope}:0`, label: "Sim, quero" });
  });

  it("clique em botão do funil SIMPLIFICADO (sem nó por trás): grava callbackData, label null", async () => {
    const bot = await createBot();
    const leadId = await createLead(bot.id, 2010n);
    // Callback no formato do funil simplificado (sp_/su_/sd_/sb_*), sem escopo
    // de nó de fluxo — não há como resolver um rótulo, mas o clique precisa
    // continuar entrando no histórico com o callback_data cru.
    await useCase.execute({ botId: bot.id, update: callbackUpdate(2010, "sp_plano123") });

    const msgs = await messagesFor(leadId);
    const click = msgs.find((m) => (m.content as Record<string, unknown>).kind === "button_click");
    expect(click).toBeDefined();
    expect(click!.content).toMatchObject({ kind: "button_click", callbackData: "sp_plano123", label: null });
  });
});

describe("registro do histórico — outbound (o que o funil manda) tem kind explícito", () => {
  it("nó `message` grava kind=text", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { message: "Bem-vindo!" } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(2011) });

    const leadId = await leadIdByChat(2011n);
    const msgs = await messagesFor(leadId);
    const outbound = msgs.find((m) => m.direction === "outbound");
    // `text` PRECISA vir preenchido: é o campo que `kind: "text"` promete pra
    // UI (`content.text`) — o nó guarda a mensagem em `content.message`, não em
    // `content.text`, então sem essa cópia explícita a bolha renderizaria vazia.
    expect(outbound?.content).toMatchObject({ kind: "text", text: "Bem-vindo!" });
  });

  it("nó `message` só de mídia/botão (sem texto) grava SEM kind — Formato 2 de sempre continua valendo", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "msg", type: "message", content: { blocks: [{ type: "media", url: "https://cdn.example.com/a.jpg" }] } },
      ],
      connections: [{ from: "trigger", to: "msg" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(2014) });

    const leadId = await leadIdByChat(2014n);
    const msgs = await messagesFor(leadId);
    const outbound = msgs.find((m) => m.direction === "outbound");
    expect(outbound?.content.kind).toBeUndefined();
  });

  it("nó `buttons` grava kind=buttons", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "btn", type: "buttons", content: { message: "Escolha:", buttons: [{ text: "A", callback: "opt_a" }] } },
      ],
      connections: [{ from: "trigger", to: "btn" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(2012) });

    const leadId = await leadIdByChat(2012n);
    const msgs = await messagesFor(leadId);
    const outbound = msgs.find((m) => m.direction === "outbound");
    expect(outbound?.content).toMatchObject({ kind: "buttons" });
  });

  it("nó `media` grava kind=media", async () => {
    const bot = await createBot();
    await createFlowFunnel({
      userId: bot.userId,
      botId: bot.id,
      nodes: [
        { key: "trigger", type: "trigger" },
        { key: "media", type: "media", content: { url: "https://cdn.example.com/a.jpg", media_type: "image" } },
      ],
      connections: [{ from: "trigger", to: "media" }],
    });
    await useCase.execute({ botId: bot.id, update: startUpdate(2013) });

    const leadId = await leadIdByChat(2013n);
    const msgs = await messagesFor(leadId);
    const outbound = msgs.find((m) => m.direction === "outbound");
    expect(outbound?.content).toMatchObject({ kind: "media" });
  });
});
