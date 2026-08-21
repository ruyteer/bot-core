// Endpoint público (sem auth) que devolve só WHATSAPP_SUPPORT_PHONE/MESSAGE
// de platform_config, pro frontend montar o botão de suporte via WhatsApp.
import { describe, it, expect } from "vitest";
import { testDb } from "../../test/helpers/db.js";
import { platformConfig } from "../shared/schema/index.js";
import { getSupportWhatsappConfig, getGatewayAffiliateLinks } from "./config.api.js";

describe("getSupportWhatsappConfig", () => {
  it("retorna phone e message quando configurados na tabela", async () => {
    const db = await testDb();
    await db.insert(platformConfig).values([
      { key: "WHATSAPP_SUPPORT_PHONE", value: "5511999999999" },
      { key: "WHATSAPP_SUPPORT_MESSAGE", value: "Olá, preciso de ajuda" },
    ]);

    const result = await getSupportWhatsappConfig();

    expect(result).toEqual({ phone: "5511999999999", message: "Olá, preciso de ajuda" });
  });

  it("retorna null quando a chave não existe", async () => {
    const result = await getSupportWhatsappConfig();
    expect(result).toEqual({ phone: null, message: null });
  });

  it("não expõe nenhuma outra chave de platform_config além dessas duas", async () => {
    const db = await testDb();
    await db.insert(platformConfig).values([
      { key: "WHATSAPP_SUPPORT_PHONE", value: "5511999999999" },
      { key: "REFERRAL_COMMISSION_PERCENT", value: "20" },
      { key: "USER_SPLIT_FEE_CENTS_someone", value: "40" },
    ]);

    const result = await getSupportWhatsappConfig();

    expect(Object.keys(result).sort()).toEqual(["message", "phone"]);
    expect(result.phone).toBe("5511999999999");
    expect(result.message).toBeNull();
    expect(JSON.stringify(result)).not.toContain("20");
    expect(JSON.stringify(result)).not.toContain("someone");
  });
});

describe("getGatewayAffiliateLinks", () => {
  it("retorna os links configurados por chave curta do provider", async () => {
    const db = await testDb();
    await db.insert(platformConfig).values([
      { key: "GATEWAY_AFFILIATE_URL_SYNCPAY",  value: "https://syncpay.example/aff/orionbot" },
      { key: "GATEWAY_AFFILIATE_URL_BUCKPAY",  value: "https://buckpay.example/aff/orionbot" },
    ]);

    const result = await getGatewayAffiliateLinks();

    expect(result).toEqual({
      links: {
        syncpay:  "https://syncpay.example/aff/orionbot",
        buckpay:  "https://buckpay.example/aff/orionbot",
        nexuspag: null,
        wiinpay:  null,
      },
    });
  });

  it("retorna null pra todos os providers quando nada foi configurado", async () => {
    const result = await getGatewayAffiliateLinks();

    expect(result).toEqual({
      links: { syncpay: null, buckpay: null, nexuspag: null, wiinpay: null },
    });
  });

  it("não expõe nenhuma outra chave de platform_config além dos 4 providers de gateway", async () => {
    const db = await testDb();
    await db.insert(platformConfig).values([
      { key: "GATEWAY_AFFILIATE_URL_SYNCPAY", value: "https://syncpay.example/aff/orionbot" },
      { key: "REFERRAL_COMMISSION_PERCENT",   value: "20" },
      { key: "USER_SPLIT_FEE_CENTS_someone",  value: "40" },
      { key: "WHATSAPP_SUPPORT_PHONE",        value: "5511999999999" },
    ]);

    const result = await getGatewayAffiliateLinks();

    expect(Object.keys(result.links).sort()).toEqual(["buckpay", "nexuspag", "syncpay", "wiinpay"]);
    expect(JSON.stringify(result)).not.toContain("20");
    expect(JSON.stringify(result)).not.toContain("someone");
    expect(JSON.stringify(result)).not.toContain("5511999999999");
  });
});
