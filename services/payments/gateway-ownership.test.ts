// Pedido de uma revisão de segurança da UI nova: update/toggle/delete/test de
// gateway checam posse SÓ no core (todo WHERE em gateway.drizzle.repository.ts
// filtra por id E userId — findByIdOwned, update, toggle, delete), sem a UI
// nova repetir essa checagem do lado dela. Isso está certo hoje, mas vivia sem
// nenhum teste: se alguém remover o filtro de userId de um WHERE, vira IDOR
// silencioso sem nada acusando. Este arquivo fixa o comportamento esperado —
// gatewayId de outro usuário sempre vira 404 limpo, nunca altera nada e nunca
// estoura um 500 cru.
//
// No caminho, achamos que update() usava `row` sem checar se a query afetou
// alguma linha: com gateway de outro usuário `row` vinha undefined e
// `row.provider` estourava um erro cru em vez do 404 esperado. toggle() e
// delete() tinham o mesmo problema, só que silencioso (retornavam sucesso sem
// mudar nada). As três correções vivem em gateway.drizzle.repository.ts.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { paymentGateways } from "../shared/schema/index.js";
import { createProfile, createGateway } from "../../test/helpers/seed.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { updateGateway, toggleGateway, deleteGateway, testGateway } = await import("./payments.api.js");

describe("posse de gateway — update/toggle/delete/test com gatewayId de outro usuário", () => {
  it("updateGateway: 404 limpo, nada é alterado", async () => {
    const owner   = await createProfile();
    const intruso = await createProfile();
    const gatewayId = await createGateway({ userId: owner, provider: "buckpay" });

    authUserId = intruso;
    await expect(updateGateway({ id: gatewayId, label: "Sequestrado" })).rejects.toMatchObject({
      code: "not_found",
    });

    const db = await testDb();
    const [row] = await db.select().from(paymentGateways).where(eq(paymentGateways.id, gatewayId));
    expect(row.label).not.toBe("Sequestrado");
  });

  it("toggleGateway: 404 limpo, isActive não muda", async () => {
    const owner   = await createProfile();
    const intruso = await createProfile();
    const gatewayId = await createGateway({ userId: owner, provider: "buckpay" });

    authUserId = intruso;
    await expect(toggleGateway({ id: gatewayId, isActive: false })).rejects.toMatchObject({
      code: "not_found",
    });

    const db = await testDb();
    const [row] = await db.select().from(paymentGateways).where(eq(paymentGateways.id, gatewayId));
    expect(row.isActive).toBe(true);
  });

  it("deleteGateway: 404 limpo, gateway continua existindo", async () => {
    const owner   = await createProfile();
    const intruso = await createProfile();
    const gatewayId = await createGateway({ userId: owner, provider: "buckpay" });

    authUserId = intruso;
    await expect(deleteGateway({ id: gatewayId })).rejects.toMatchObject({
      code: "not_found",
    });

    const db = await testDb();
    expect((await db.select().from(paymentGateways).where(eq(paymentGateways.id, gatewayId))).length).toBe(1);
  });

  it("testGateway: 404 limpo, nenhum PIX é gerado", async () => {
    const owner   = await createProfile();
    const intruso = await createProfile();
    const gatewayId = await createGateway({ userId: owner, provider: "buckpay" });

    authUserId = intruso;
    await expect(testGateway({ id: gatewayId })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
