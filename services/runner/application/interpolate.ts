// Replaces {{variable_name}} placeholders with values from the variable map.
// Falls back to empty string for unknown variables.
export function interpolate(template: string, vars: Map<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars.get(key) ?? "");
}
