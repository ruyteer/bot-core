// Achado da auditoria: `remarketing_campaigns.stop_on_reply` era gravado na
// criação/edição da campanha (remarketing.api.ts) mas nunca lido em lugar
// nenhum — o runner ignorava a opção e a campanha continuava mandando
// mensagem pro lead mesmo depois dele responder. A correção mora em
// process-remarketing.use-case.ts (stopRemarketingOnLeadReply), mas o que
// importa pro produto é a FIAÇÃO: qualquer mensagem inbound do lead — texto,
// mídia ou clique de botão — precisa acionar aquela função. Este teste exercita
// o ponto de entrada REAL (ExecuteFlowStepUseCase.execute, chamado pelo
// subscriber do webhook em runner.ts), não a função isolada.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { ExecuteFlowStepUseCase } from "./execute-flow-step.use-case.js";
import { testDb } from "../../../test/helpers/db.js";
import { leads, remarketingCampaigns, remarketingMessages, remarketingLeadState } from "../../shared/schema/index.js";
import { createBot, createFlowFunnel, startUpdate, textUpdate } from "../../../test/helpers/seed.js";

const useCase = new ExecuteFlowStepUseCase();

async function leadIdByChat(botId: string, chatId: number): Promise<string> {
  const db = await testDb();
  const [l] = await db.select().from(leads).where(eq(leads.botId, botId));
  return l.id;
}

describe("stop_on_reply: lead que manda mensagem para a inscrição em campanhas de remarketing com essa opção", () => {
  it("mensagem de texto do lead para o estado de uma campanha com stop_on_reply=true", async () => {
    const bot = await createBot();
    // /start cria o lead antes do teste poder inscrevê-lo no remarketing.
    await useCase.execute({ botId: bot.id, update: startUpdate(9001) });
    const leadId = await leadIdByChat(bot.id, 9001);

    const db = await testDb();
    const [camp] = await db.insert(remarketingCampaigns).values({
      botId: bot.id, botIds: [bot.id], name: "Camp", triggerType: "manual",
      isActive: true, filterType: "all", stopOnReply: true,
    }).returning();
    await db.insert(remarketingMessages).values({ campaignId: camp.id, message: "Volte!", delayValue: 1, delayUnit: "days", orderIndex: 0 });
    const [st] = await db.insert(remarketingLeadState).values({
      campaignId: camp.id, botId: bot.id, leadId, status: "active", nextSendAt: new Date(Date.now() + 60_000), nextMessageIndex: 0,
    }).returning();

    // Lead manda uma mensagem qualquer — não é o /start, é uma resposta normal.
    await useCase.execute({ botId: bot.id, update: textUpdate(9001, "oi, ainda tenho interesse") });

    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.status).toBe("stopped");
    expect(after.pauseReason).toBe("lead_replied");
  });

  it("não mexe na inscrição quando a campanha tem stop_on_reply=false", async () => {
    const bot = await createBot();
    await useCase.execute({ botId: bot.id, update: startUpdate(9002) });
    const leadId = await leadIdByChat(bot.id, 9002);

    const db = await testDb();
    const [camp] = await db.insert(remarketingCampaigns).values({
      botId: bot.id, botIds: [bot.id], name: "Camp", triggerType: "manual",
      isActive: true, filterType: "all", stopOnReply: false,
    }).returning();
    await db.insert(remarketingMessages).values({ campaignId: camp.id, message: "Volte!", delayValue: 1, delayUnit: "days", orderIndex: 0 });
    const [st] = await db.insert(remarketingLeadState).values({
      campaignId: camp.id, botId: bot.id, leadId, status: "active", nextSendAt: new Date(Date.now() + 60_000), nextMessageIndex: 0,
    }).returning();

    await useCase.execute({ botId: bot.id, update: textUpdate(9002, "oi") });

    const [after] = await db.select().from(remarketingLeadState).where(eq(remarketingLeadState.id, st.id));
    expect(after.status).toBe("active");
  });
});
