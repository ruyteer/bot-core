// Replaces {{variable_name}} placeholders with values from the variable map.
// Falls back to empty string for unknown variables.
export function interpolate(template: string, vars: Map<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars.get(key) ?? "");
}

// Campos NATIVOS do lead (Telegram) disponíveis como variáveis de interpolação:
// {{first_name}}, {{last_name}}, {{username}}, {{nome}}, {{name}}. O painel sugere
// essas variáveis, mas elas não são lead_variables — então precisam ser injetadas.
export interface LeadLike {
  firstName?: string | null;
  lastName?: string | null;
  telegramUsername?: string | null;
}

export function leadFieldsMap(lead: LeadLike): Map<string, string> {
  const m = new Map<string, string>();
  if (lead.firstName)        m.set("first_name", lead.firstName);
  if (lead.lastName)         m.set("last_name", lead.lastName);
  if (lead.telegramUsername) m.set("username", lead.telegramUsername);
  const full = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim();
  const nome = full || lead.firstName || "";
  if (nome) { m.set("nome", nome); m.set("name", nome); }
  return m;
}

// Mescla os campos nativos do lead num mapa de variáveis EXISTENTE, sem sobrescrever
// variáveis já definidas pelo usuário (lead_variables têm precedência).
export function mergeLeadFields(vars: Map<string, string>, lead: LeadLike): void {
  for (const [k, v] of leadFieldsMap(lead)) if (!vars.has(k)) vars.set(k, v);
}
