// SQLSTATE 23505 (unique_violation) — tanto o driver de produção (pg/
// node-postgres) quanto o PGlite dos testes expõem o código e o nome da
// constraint violada em `err.code`/`err.constraint`. Confere o NOME também,
// pra não tratar qualquer unique_violation da tabela como a mesma corrida.
export function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | null | undefined;
  if (!e || e.code !== "23505") return false;
  return e.constraint === constraintName || (typeof e.message === "string" && e.message.includes(constraintName));
}
