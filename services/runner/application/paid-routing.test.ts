import { describe, expect, it } from "vitest";
import { routePaidPayment } from "./paid-routing.js";

describe("routePaidPayment", () => {
  it("compra flow COM order bump vai pro flow (entrega o produto principal e retoma o funil)", () => {
    expect(
      routePaidPayment({
        nodeId: "11111111-1111-1111-1111-111111111111",
        progressId: "22222222-2222-2222-2222-222222222222",
        simplifiedCtx: { kind: "plan", funnelId: "f", items: [{ name: "Bonus", delivery_type: "content", delivery_url: "https://x", delivery_text: null, vip_group_id: null, access_days: 0 }] },
      } as never),
    ).toBe("flow");
  });

  it("compra flow sem bump continua indo pro flow", () => {
    expect(routePaidPayment({ nodeId: "n", progressId: "p", simplifiedCtx: null } as never)).toBe("flow");
  });

  it("compra do funil simplificado vai pro simplificado", () => {
    expect(routePaidPayment({ nodeId: null, progressId: null, simplifiedCtx: { kind: "plan", funnelId: "f", items: [] } } as never)).toBe("simplified");
  });

  it("oferta avulsa (disparo/remarketing, sem funil) vai pro flow, que entrega pelo offerId", () => {
    expect(routePaidPayment({ nodeId: null, progressId: null, simplifiedCtx: null } as never)).toBe("flow");
  });
});
