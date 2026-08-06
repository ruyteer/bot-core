// Stub de `encore.dev/api` para testes. Mantém os endpoints como funções
// chamáveis diretamente (api/api.raw devolvem o handler) e fornece APIError.

type Handler = (...args: unknown[]) => unknown;

function makeApi() {
  const fn = ((_opts: unknown, handler: Handler) => handler) as Handler & {
    raw: (opts: unknown, handler: Handler) => Handler;
    static: (opts: unknown, handler?: Handler) => Handler;
  };
  fn.raw = (_opts: unknown, handler: Handler) => handler;
  fn.static = (_opts: unknown, handler?: Handler) => handler ?? (() => undefined);
  return fn;
}

export const api = makeApi();

export class APIError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "APIError";
  }
  static notFound(m: string) { return new APIError("not_found", m); }
  static invalidArgument(m: string) { return new APIError("invalid_argument", m); }
  static permissionDenied(m: string) { return new APIError("permission_denied", m); }
  static unauthenticated(m: string) { return new APIError("unauthenticated", m); }
  static alreadyExists(m: string) { return new APIError("already_exists", m); }
  static internal(m: string) { return new APIError("internal", m); }
  static failedPrecondition(m: string) { return new APIError("failed_precondition", m); }
  static resourceExhausted(m: string) { return new APIError("resource_exhausted", m); }
  static unavailable(m: string) { return new APIError("unavailable", m); }
}

export const ErrCode = {
  NotFound: "not_found",
  InvalidArgument: "invalid_argument",
  PermissionDenied: "permission_denied",
  Unauthenticated: "unauthenticated",
} as const;

// Tipos auxiliares (apagados em runtime, mas precisam existir como export).
export type Header<_N extends string = string> = string;
export type Query<_N extends string = string> = string;

export class Gateway {
  constructor(public cfg: unknown) {}
}
