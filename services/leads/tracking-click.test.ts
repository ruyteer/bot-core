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
import { CLICK_RATE_LIMIT, _resetClickRateLimiterForTests } from "./application/click-rate-limiter.js";
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

describe("registerTrackingClick — limite de replay por IP+bot", () => {
  it("acima do limite, gera um token NOVO clonando as UTMs do último clique — não reaproveita o mesmo token", async () => {
    _resetClickRateLimiterForTests();
    const bot = await botWithFunnel();
    const ip = "203.0.113.9";

    let lastUrl = "";
    for (let i = 0; i < CLICK_RATE_LIMIT.maxPerWindow; i++) {
      lastUrl = (await registerTrackingClick({ botId: bot.id, clientIp: ip, utmSource: "facebook", utmCampaign: "bf" }))!.url;
    }

    const db = await testDb();
    const rowsBeforeOverflow = await db.select().from(trackingClicks).where(eq(trackingClicks.botId, bot.id));
    expect(rowsBeforeOverflow.length).toBe(CLICK_RATE_LIMIT.maxPerWindow);

    // Um clique a mais estourando a janela: grava uma linha NOVA com token
    // DIFERENTE do último — reciclar o mesmo token quebrava com o resgate de
    // uso único (CGNAT/rede corporativa/wifi público colocam visitantes
    // DISTINTOS atrás do mesmo IP; cada um precisa do próprio token, senão só
    // o primeiro fica com a atribuição e os demais perdem em silêncio).
    const overLimit = await registerTrackingClick({ botId: bot.id, clientIp: ip, utmSource: "facebook", utmCampaign: "bf" });
    expect(overLimit!.url).not.toBe(lastUrl);

    const rowsAfterOverflow = await db.select().from(trackingClicks).where(eq(trackingClicks.botId, bot.id));
    expect(rowsAfterOverflow.length).toBe(CLICK_RATE_LIMIT.maxPerWindow + 1);

    // A linha nova herdou as UTMs do último clique legítimo (não ficou vazia).
    const newToken = new URL(overLimit!.url).searchParams.get("start")!.slice(3);
    const [newRow] = await db.select().from(trackingClicks).where(eq(trackingClicks.token, newToken));
    expect(newRow.utmSource).toBe("facebook");
    expect(newRow.utmCampaign).toBe("bf");
  });

  it("7 cliques do mesmo IP acima do limite (5) → 7 /start distintos, todos atribuídos", async () => {
    _resetClickRateLimiterForTests();
    const bot = await botWithFunnel();
    const ip = "198.51.100.42";

    const urls: string[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await registerTrackingClick({
        botId: bot.id, clientIp: ip, utmSource: "facebook", utmCampaign: "black_friday",
      });
      urls.push(res!.url);
    }

    // 7 tokens distintos — nenhum reaproveitado entre os 7 cliques.
    const tokens = urls.map((u) => new URL(u).searchParams.get("start")!);
    expect(new Set(tokens).size).toBe(7);

    for (let i = 0; i < tokens.length; i++) {
      await runner.execute({ botId: bot.id, update: textUpdate(7000 + i, `/start ${tokens[i]}`) });
    }

    const db = await testDb();
    const rows = await db.select().from(leads).where(eq(leads.botId, bot.id));
    expect(rows.length).toBe(7);
    for (const lead of rows) {
      expect(lead.utmSource).toBe("facebook");
      expect(lead.utmCampaign).toBe("black_friday");
    }
  });

  it("IPs diferentes no mesmo bot não competem pelo mesmo limite", async () => {
    _resetClickRateLimiterForTests();
    const bot = await botWithFunnel();

    for (let i = 0; i < CLICK_RATE_LIMIT.maxPerWindow; i++) {
      await registerTrackingClick({ botId: bot.id, clientIp: "198.51.100.1" });
    }
    // Outro IP no mesmo bot ainda grava normalmente — o limite é por (ip, botId).
    const other = await registerTrackingClick({ botId: bot.id, clientIp: "198.51.100.2" });
    expect(other).not.toBeNull();

    const db = await testDb();
    const rows = await db.select().from(trackingClicks).where(eq(trackingClicks.botId, bot.id));
    expect(rows.length).toBe(CLICK_RATE_LIMIT.maxPerWindow + 1);
  });

  it("sem IP (proxy que não repassa nada), não aplica rate limit", async () => {
    _resetClickRateLimiterForTests();
    const bot = await botWithFunnel();
    for (let i = 0; i < CLICK_RATE_LIMIT.maxPerWindow + 2; i++) {
      const res = await registerTrackingClick({ botId: bot.id });
      expect(res).not.toBeNull();
    }
    const db = await testDb();
    const rows = await db.select().from(trackingClicks).where(eq(trackingClicks.botId, bot.id));
    expect(rows.length).toBe(CLICK_RATE_LIMIT.maxPerWindow + 2);
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

describe("applyStartTracking direto — resgate atômico e de uso único", () => {
  it("segundo /start com o mesmo token não sobrescreve o vínculo original nem aplica UTM de novo", async () => {
    const bot = await botWithFunnel();
    const db = await testDb();
    const { url } = (await registerTrackingClick({ botId: bot.id, utmSource: "facebook" }))!;
    const token = new URL(url).searchParams.get("start")!;

    await runner.execute({ botId: bot.id, update: textUpdate(6001, `/start ${token}`) });
    const [firstClick] = await db.select().from(trackingClicks);
    const firstLeadId = firstClick.leadId;
    const firstConsumedAt = firstClick.consumedAt;

    // Ataque: reusar o mesmo tk_ (compartilhado, capturado no histórico do
    // chat etc.) num segundo /start — token já resgatado não pode gerar uma
    // segunda atribuição.
    await runner.execute({ botId: bot.id, update: textUpdate(6002, `/start ${token}`) });
    const [after] = await db.select().from(trackingClicks);
    expect(after.leadId).toBe(firstLeadId);
    expect(after.consumedAt?.getTime()).toBe(firstConsumedAt?.getTime());

    // O segundo lead NÃO recebe as UTMs do clique alheio — token de uso único.
    const rows = await db.select().from(leads);
    const second = rows.find((l) => l.telegramChatId === BigInt(6002))!;
    expect(second.utmSource).toBeNull();
  });

  it("token emitido para o bot A não pode ser resgatado no /start do bot B", async () => {
    const botA = await botWithFunnel();
    const botB = await botWithFunnel();
    const db = await testDb();
    const { url } = (await registerTrackingClick({ botId: botA.id, utmSource: "facebook", utmCampaign: "camp_a" }))!;
    const token = new URL(url).searchParams.get("start")!;

    // Ataque: pegar o tk_ emitido para o bot A e mandar pro /start do bot B.
    await runner.execute({ botId: botB.id, update: textUpdate(6101, `/start ${token}`) });

    const [click] = await db.select().from(trackingClicks).where(eq(trackingClicks.botId, botA.id));
    expect(click.consumedAt).toBeNull();
    expect(click.leadId).toBeNull();

    const leadB = (await db.select().from(leads).where(eq(leads.botId, botB.id)))[0];
    expect(leadB.utmSource).toBeNull();
    expect(leadB.utmCampaign).toBeNull();

    // O token continua íntegro e resgatável no bot certo (A).
    await runner.execute({ botId: botA.id, update: textUpdate(6102, `/start ${token}`) });
    const leadA = (await db.select().from(leads).where(eq(leads.botId, botA.id)))[0];
    expect(leadA.utmSource).toBe("facebook");
    expect(leadA.utmCampaign).toBe("camp_a");
  });
});
