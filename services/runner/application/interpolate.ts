// Substituição de variáveis nos textos do funil.
//
// O PAINEL insere variáveis com UMA chave — {nome}, {sobrenome}, {username},
// {email}... (VariableSelector, hints do NodeEditPanel, remarketing). O
// interpolador antigo só reconhecia {{var}} (duas chaves) — resultado: nada do
// que o seletor inseria era substituído e o lead via "{nome}" literal.
//
// Regras:
// - {{var}}: sintaxe legada. Desconhecida vira "" (comportamento antigo).
// - {var}:   sintaxe do painel. Desconhecida fica LITERAL — protege tokens de
//   outros substituidores (ex.: {valor}/{produto} dos textos de PIX, trocados
//   depois por replacePixVariables) e chaves digitadas de propósito.
// - Lookup case-insensitive ({NOME} também funciona, como no remarketing).
export function interpolate(template: string, vars: Map<string, string>): string {
  const lookup = (key: string): string | undefined =>
    vars.get(key) ?? vars.get(key.toLowerCase());
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => lookup(key) ?? "")
    .replace(/\{(\w+)\}/g, (match, key: string) => lookup(key) ?? match);
}

// Campos NATIVOS do lead (Telegram) disponíveis como variáveis de interpolação:
// {nome}, {sobrenome}, {username}, {first_name}, {last_name}, {name}. O painel
// sugere essas variáveis, mas elas não são lead_variables — são injetadas daqui.
export interface LeadLike {
  firstName?: string | null;
  lastName?: string | null;
  telegramUsername?: string | null;
}

export function leadFieldsMap(lead: LeadLike): Map<string, string> {
  const m = new Map<string, string>();
  const first = lead.firstName ?? "";
  const last  = lead.lastName ?? "";
  // Sempre setadas (mesmo vazias): variável de lead sem valor deve sumir do
  // texto, não aparecer como "{nome}" literal.
  m.set("first_name", first);
  m.set("last_name", last);
  m.set("sobrenome", last);
  m.set("username", lead.telegramUsername ?? "");
  // {nome} = primeiro nome, igual ao remarketing ("Oi João", não "Oi João S...").
  m.set("nome", first);
  m.set("name", first);
  return m;
}

// Mescla os campos nativos do lead num mapa de variáveis EXISTENTE, sem sobrescrever
// variáveis já definidas pelo usuário (lead_variables têm precedência).
export function mergeLeadFields(vars: Map<string, string>, lead: LeadLike): void {
  for (const [k, v] of leadFieldsMap(lead)) if (!vars.has(k)) vars.set(k, v);
}
