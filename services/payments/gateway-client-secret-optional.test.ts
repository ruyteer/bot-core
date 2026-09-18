// Furo: clientSecret era obrigatório no tipo de criação de gateway mesmo pra
// provedores que não usam de fato client secret (só o SyncPay usa — ver
// gateway-clients.ts, buckpay/nexuspag/wiinpay ignoram o parâmetro). A UI
// antiga contornava mandando uma string vazia ou um sentinel; isto confirma
// que os dois formatos continuam funcionando e que o SyncPay ainda exige.
import { describe, it, expect, vi } from "vitest";
import { createProfile } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { createGateway: createGatewayEndpoint } = await import("./payments.api.js");

describe("createGateway — clientSecret opcional", () => {
  it("buckpay sem clientSecret: cria normalmente", async () => {
    const userId = await createProfile();
    authUserId = userId;
    const gw = await createGatewayEndpoint({ provider: "buckpay", label: "BuckPay", clientId: "cid" });
    expect(gw.provider).toBe("buckpay");
  });

  it("buckpay com clientSecret vazio (comportamento antigo da UI): continua funcionando", async () => {
    const userId = await createProfile();
    authUserId = userId;
    const gw = await createGatewayEndpoint({ provider: "buckpay", label: "BuckPay", clientId: "cid", clientSecret: "" });
    expect(gw.provider).toBe("buckpay");
  });

  it("syncpay sem clientSecret: erro de validação (é o único provider que usa de fato)", async () => {
    const userId = await createProfile();
    authUserId = userId;
    await expect(createGatewayEndpoint({ provider: "syncpay", label: "SyncPay", clientId: "cid" }))
      .rejects.toThrow(/clientSecret/);
  });

  it("syncpay com clientSecret: cria normalmente", async () => {
    const userId = await createProfile();
    authUserId = userId;
    const gw = await createGatewayEndpoint({ provider: "syncpay", label: "SyncPay", clientId: "cid", clientSecret: "shh" });
    expect(gw.provider).toBe("syncpay");
  });
});
