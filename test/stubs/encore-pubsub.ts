// Stub de `encore.dev/pubsub` para os testes (aliased no vitest.config.ts).
// Captura publicações para asserção e permite registrar handlers de subscription
// que os testes podem disparar manualmente.

export const published: Array<{ topic: string; event: unknown }> = [];

export function __resetPubsub(): void {
  published.length = 0;
}

export class Topic<T> {
  constructor(public readonly name: string, _opts?: unknown) {}
  async publish(event: T): Promise<string> {
    published.push({ topic: this.name, event });
    return "test-msg-id";
  }
}

export class Subscription<T> {
  constructor(
    public readonly topic: Topic<T>,
    public readonly name: string,
    public readonly cfg: { handler: (event: T) => Promise<void> },
  ) {}
}
