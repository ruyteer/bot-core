// Furo: DELETE /gateways/:id com pagamento vinculado estourava a violação de
// chave estrangeira crua (payments.gateway_id não tem onDelete) — 500 direto
// do driver em vez de um erro tipado e claro. A UI antiga já avisa o usuário
// disso no dialog de confirmação ("Se houver pagamentos vinculados, a
// exclusão não será possível"), mas a API nunca chegou a cumprir essa promessa.
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../../test/helpers/db.js";
import { __setTestDb } from "../shared/database.js";
import { paymentGateways, payments } from "../shared/schema/index.js";
import { createProfile, createBot, createGateway } from "../../test/helpers/seed.js";
import { GatewayDrizzleRepository } from "./infrastructure/gateway.drizzle.repository.js";

let authUserId = "";
vi.mock("~encore/auth", () => ({
  getAuthData: () => (authUserId ? { userID: authUserId } : null),
}));

const { deleteGateway } = await import("./payments.api.js");

const gwRepo = new GatewayDrizzleRepository();

describe("deleteGateway — pagamento vinculado", () => {
  it("gateway com pagamento vinculado: erro tipado (failed_precondition), gateway continua existindo", async () => {
    const userId = await createProfile();
    const bot = await createBot({ userId });
    const gatewayId = await createGateway({ userId });
    const db = await testDb();
    await db.insert(payments).values({ userId, botId: bot.id, gatewayId, amount: 1000, status: "paid" });

    authUserId = userId;
    await expect(deleteGateway({ id: gatewayId })).rejects.toMatchObject({
      code: "failed_precondition",
      message: expect.stringContaining("pagamentos vinculados"),
    });

    const rows = await db.select().from(paymentGateways).where(eq(paymentGateways.id, gatewayId));
    expect(rows.length).toBe(1);
  });

  it("gateway sem pagamento nenhum: exclui normalmente", async () => {
    const userId = await createProfile();
    const gatewayId = await createGateway({ userId });
    authUserId = userId;
    await expect(deleteGateway({ id: gatewayId })).resolves.toBeUndefined();

    const db = await testDb();
    expect((await db.select().from(paymentGateways).where(eq(paymentGateways.id, gatewayId))).length).toBe(0);
  });

  // Simula a corrida entre a checagem prévia (SELECT count) e o DELETE de
  // verdade: um pagamento "aparece" só depois da checagem passar. O DELETE é
  // forçado a estourar a mesma violação de FK que o Postgres real devolveria
  // nesse cenário — o que o teste cobre é o catch do repositório traduzindo
  // isso pro mesmo erro tipado, não a concorrência real do PGlite.
  it("corrida entre a checagem e o delete: violação de FK também vira erro tipado, não erro cru", async () => {
    const userId = await createProfile();
    const gatewayId = await createGateway({ userId });
    const realDb = await testDb();

    const fakeDb = {
      select: realDb.select.bind(realDb),
      delete: () => ({
        where: async () => {
          throw Object.assign(
            new Error('update or delete on table "payment_gateways" violates foreign key constraint "payments_gateway_id_fkey" on table "payments"'),
            { code: "23503", constraint: "payments_gateway_id_fkey" },
          );
        },
      }),
    };

    try {
      __setTestDb(fakeDb as unknown as Parameters<typeof __setTestDb>[0]);
      await expect(gwRepo.delete(gatewayId, userId)).rejects.toMatchObject({
        code: "failed_precondition",
        message: expect.stringContaining("pagamentos vinculados"),
      });
    } finally {
      __setTestDb(realDb as unknown as Parameters<typeof __setTestDb>[0]);
    }

    const rows = await realDb.select().from(paymentGateways).where(eq(paymentGateways.id, gatewayId));
    expect(rows.length).toBe(1); // o delete forçado a falhar não mexeu em nada de verdade
  });
});
