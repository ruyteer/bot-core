// Stub de `encore.dev/auth`. authHandler devolve o próprio handler para teste direto.
type Handler = (...args: unknown[]) => unknown;
export function authHandler(handler: Handler): Handler { return handler; }
export class Gateway { constructor(public cfg: unknown) {} }
export function getAuthData<T = unknown>(): T | null { return null; }
