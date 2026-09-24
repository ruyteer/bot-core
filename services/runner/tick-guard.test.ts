// Guarda de reentrada dos ticks do runner (fast/slow): impede duas execuções
// do MESMO laço rodando em paralelo, mas se recupera sozinha se um tick
// travar de vez além do teto (maxMs). Bug corrigido aqui (auditoria — "guard
// do tick lento quebrado"): o `finally` antigo zerava a marca de execução
// incondicionalmente, então um tick "morto" que finalmente terminava (depois
// de já ter sido substituído por um tick mais novo) apagava a marca do tick
// novo — liberando um TERCEIRO tick pra rodar em cima do segundo, ainda em
// andamento. Os testes abaixo isolam essa lógica sem depender do corpo real
// do tick (setInterval, banco, rede) — ver createTickGuard em runner.ts.
import { describe, it, expect } from "vitest";
import { createTickGuard } from "./runner.js";

describe("createTickGuard", () => {
  it("bloqueia uma segunda execução enquanto a primeira ainda está rodando", async () => {
    const guard = createTickGuard(100_000);
    let concurrent = 0;
    let maxConcurrent = 0;
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => { resolveFirst = r; });

    const p1 = guard(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate;
      concurrent--;
    });

    let secondCalled = false;
    const p2 = guard(async () => { secondCalled = true; });
    await p2; // reentrada: retorna na hora, sem chamar a função

    expect(secondCalled).toBe(false);

    resolveFirst();
    await p1;
    expect(maxConcurrent).toBe(1); // nunca rodou em paralelo
  });

  it("libera a próxima execução sozinha depois que a atual termina", async () => {
    const guard = createTickGuard(100_000);
    let calls = 0;
    await guard(async () => { calls++; });
    await guard(async () => { calls++; });
    expect(calls).toBe(2);
  });

  it("uma execução que lança erro ainda libera a marca (finally roda mesmo em falha)", async () => {
    const guard = createTickGuard(100_000);
    await expect(guard(async () => { throw new Error("boom"); })).rejects.toThrow("boom");

    let ranAfter = false;
    await guard(async () => { ranAfter = true; });
    expect(ranAfter).toBe(true);
  });

  it("regressão: um tick 'morto' que resolve tarde não apaga a marca do tick que já assumiu no lugar dele (não empilha em cascata)", async () => {
    const maxMs = 1_000;
    const guard = createTickGuard(maxMs);
    const base = 1_000_000; // qualquer timestamp positivo — 0 colide com o sentinel "livre"

    let resolveTick1!: () => void;
    const tick1Gate = new Promise<void>((r) => { resolveTick1 = r; });
    let resolveTick2!: () => void;
    const tick2Gate = new Promise<void>((r) => { resolveTick2 = r; });

    // Tick 1 começa em `base` e "trava" (não resolve ainda).
    const p1 = guard(async () => { await tick1Gate; }, base);

    // now = base + 2*maxMs: passou do teto — o guard presume tick1 morto e
    // libera um tick novo, que também ainda está rodando (tick2Gate pendente).
    const p2 = guard(async () => { await tick2Gate; }, base + 2 * maxMs);

    // Tick 1 finalmente "acorda" e termina — SEM o fix, seu `finally` zeraria
    // a marca agora ocupada pelo tick 2 (ainda rodando de verdade).
    resolveTick1();
    await p1;

    // now = base + 2*maxMs + metade do teto: tick2 ainda está rodando — um
    // tick3 que chegasse agora deve continuar BLOQUEADO.
    let tick3Ran = false;
    const p3 = guard(async () => { tick3Ran = true; }, base + 2 * maxMs + maxMs / 2);
    await p3;
    expect(tick3Ran).toBe(false); // reentrada corretamente bloqueada

    resolveTick2();
    await p2;

    // Com tick2 encerrado (e sua própria marca liberada), um tick novo roda.
    let tick4Ran = false;
    await guard(async () => { tick4Ran = true; }, base + 2 * maxMs + maxMs + 1);
    expect(tick4Ran).toBe(true);
  });
});
