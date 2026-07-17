import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";
import { databaseUrl } from "../config/secrets.js";

type DB = NodePgDatabase<typeof schema>;

// Instância única. Em produção é construída preguiçosamente na 1ª query (assim o
// import deste módulo não abre conexão à toa). Em testes, `__setTestDb` injeta um
// driver alternativo (PGlite) ANTES do 1º uso — nenhum call-site muda.
let _db: DB | undefined;

function build(): DB {
  const pool = new Pool({
    connectionString: databaseUrl(),
    max: 10,
    // idle alto + keepAlive: com tráfego baixo, conexões que expiram a cada 30s
    // faziam TODO update pagar handshake TCP+TLS novo (lento e instável — era a
    // fonte dos "Connection terminated" do scheduler). O tick de 60s do runner
    // mantém o pool aquecido dentro desta janela.
    idleTimeoutMillis: 10 * 60_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  return drizzle(pool, { schema });
}

/**
 * Hook de teste: injeta um driver Drizzle alternativo (ex.: PGlite em memória).
 * Não tem efeito em produção (nunca é chamado fora dos testes).
 */
export function __setTestDb(instance: DB): void {
  _db = instance;
}

// `db` é um Proxy estável: preserva a identidade do export e resolve a instância
// real (lazy) a cada acesso, fazendo bind do `this` correto nos métodos Drizzle.
export const db: DB = new Proxy({} as DB, {
  get(_target, prop) {
    if (!_db) _db = build();
    const value = (_db as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(_db)
      : value;
  },
});
