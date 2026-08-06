// Rastreamento de tráfego pago (/r → tk_ → /start) e orgânico (src_ no payload).
// A Edge Function tracking-redirect do Supabase morreu na migração e nada no
// Encore gravava UTMs no lead — estes testes cobrem o fluxo reconstruído.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { createBot, createFlowFunnel, textUpdate } from "../../test/helpers/seed.js";
import { getSentMessages } from "../../test/helpers/fetch-mock.js";
import { leads, trackingClicks, bots } from "../shared/schema/index.js";
import { registerTrackingClick, applyStartTracking } from "./application/tracking-click.js";
import { ExecuteFlowStepUseCase } from "../runner/application/execute-flow-step.use-case.js";

const runner = new ExecuteFlowStepUseCase();

async function botWithFunnel() {
  const bot = await createBot();
  const db = await testDb();
  await db.update(bots).set({ telegramUsername: "meubot" }).where(eq(bots.id, bot.id));
  await createFlowFunnel({
    userId: bot.userId,
    botId:  bot.id,
    nodes: [
      { key: "trigger", type: "trigger" },
      { key: "msg", type: "message", content: { message: "Bem-vindo!" } },
    ],
    connections: [{ from: "trigger", to: "msg" }],
  });
  return bot;
}

describe("registerTrackingClick (/r)", () => {
  it("grava o clique e devolve t.me com start=tk_<token>", async () => {
    const bot = await botWithFunnel();
    const res = await registerTrackingClick({
      botId: bot.id,
      platform: "meta",
      utmSource: "facebook", utmMedium: "cpc", utmCampaign: "bf_vsl1",
      fbclid: "IwAR123",
      clientIp: "1.2.3.4", userAgent: "Mozilla/5.0",
    });
    expect(res).not.toBeNull();
    expect(res!.url).toMatch(/^https:\/\/t\.me\/meubot\?start=tk_[0-9a-f]{32}$/);

    const db = await testDb();
    const [click] = await db.select().from(trackingClicks);
    expect(click.utmCampaign).toBe("bf_vsl1");
    expect(click.fbclid).toBe("IwAR123");
  });

  it("macro não substituída ({{campaign.name}}) não vira UTM", async () => {
    const bot = await botWithFunnel();
    await registerTrackingClick({
      botId: bot.id,
      utmSource: "facebook",
      utmCampaign: "{{campaign.name}}",
      utmContent: "__AID_NAME__",
      utmTerm: "{keyword}",
    });
    const db = await testDb();
    const [click] = await db.select().from(trackingClicks);
    expect(click.utmSource).toBe("facebook");
    expect(click.utmCampaign).toBeNull();
    expect(click.utmContent).toBeNull();
    expect(click.utmTerm).toBeNull();
  });

  it("bot inexistente retorna null", async () => {
    expect(await registerTrackingClick({ botId: crypto.randomUUID() })).toBeNull();
  });
});

describe("/start tk_<token> — tráfego pago de ponta a ponta", () => {
  it("aplica UTMs e click ids no lead, liga o clique e dispara o funil", async () => {
    const bot = await botWithFunnel();
    const { url } = (await registerTrackingClick({
      botId: bot.id,
      utmSource: "facebook", utmMedium: "cpc", utmCampaign: "bf_vsl1",
      utmContent: "criativo_a", utmTerm: "adset_x",
      fbclid: "IwAR999", clientIp: "9.8.7.6", userAgent: "UA-teste",
    }))!;
    const startParam = new URL(url).searchParams.get("start")!;

    await runner.execute({ botId: bot.id, update: textUpdate(5001, `/start ${startParam}`) });

    const db = await testDb();
    const [lead] = await db.select().from(leads);
    expect(lead.utmSource).toBe("facebook");
    expect(lead.utmMedium).toBe("cpc");
    expect(lead.utmCampaign).toBe("bf_vsl1");
    expect(lead.utmContent).toBe("criativo_a");
    expect(lead.utmTerm).toBe("adset_x");
    expect(lead.fbclid).toBe("IwAR999");
    expect(lead.clientIp).toBe("9.8.7.6");
    expect(lead.clientUserAgent).toBe("UA-teste");

    const [click] = await db.select().from(trackingClicks);
    expect(click.leadId).toBe(lead.id);
    expect(click.consumedAt).not.toBeNull();

    // O deep link também dispara o funil (não só o "/start" seco).
    expect(getSentMessages()).toContain("Bem-vindo!");
  });

  it("token desconhecido não quebra o /start", async () => {
    const bot = await botWithFunnel();
    await runner.execute({ botId: bot.id, update: textUpdate(5002, "/start tk_deadbeef") });
    expect(getSentMessages()).toContain("Bem-vindo!");
    const db = await testDb();
    const [lead] = await db.select().from(leads);
    expect(lead.utmSource).toBeNull();
  });
});

describe("/start src_... — payload orgânico", () => {
  it("grava as 5 UTMs do payload no lead", async () => {
    const bot = await botWithFunnel();
    await runner.execute({
      botId: bot.id,
      update: textUpdate(5003, "/start src_instagram__m_bio__c_lancamento__ct_v2__t_promo"),
    });
    const db = await testDb();
    const [lead] = await db.select().from(leads);
    expect(lead.utmSource).toBe("instagram");
    expect(lead.utmMedium).toBe("bio");
    expect(lead.utmCampaign).toBe("lancamento");
    expect(lead.utmContent).toBe("v2");
    expect(lead.utmTerm).toBe("promo");
    expect(getSentMessages()).toContain("Bem-vindo!");
  });

  it("payload que não é rastreamento (ref antigo) é ignorado sem erro", async () => {
    const bot = await botWithFunnel();
    await runner.execute({ botId: bot.id, update: textUpdate(5004, "/start ref123") });
    const db = await testDb();
    const [lead] = await db.select().from(leads);
    expect(lead.utmSource).toBeNull();
  });
});

describe("applyStartTracking direto", () => {
  it("segundo clique no mesmo token não sobrescreve o vínculo original", async () => {
    const bot = await botWithFunnel();
    const db = await testDb();
    const { url } = (await registerTrackingClick({ botId: bot.id, utmSource: "facebook" }))!;
    const token = new URL(url).searchParams.get("start")!;

    await runner.execute({ botId: bot.id, update: textUpdate(6001, `/start ${token}`) });
    const [firstClick] = await db.select().from(trackingClicks);
    const firstLeadId = firstClick.leadId;
    const firstConsumedAt = firstClick.consumedAt;

    await runner.execute({ botId: bot.id, update: textUpdate(6002, `/start ${token}`) });
    const [after] = await db.select().from(trackingClicks);
    expect(after.leadId).toBe(firstLeadId);
    expect(after.consumedAt?.getTime()).toBe(firstConsumedAt?.getTime());

    // Mas o segundo lead ainda recebe as UTMs do clique.
    const rows = await db.select().from(leads);
    const second = rows.find((l) => l.telegramChatId === BigInt(6002))!;
    expect(second.utmSource).toBe("facebook");
  });
});
