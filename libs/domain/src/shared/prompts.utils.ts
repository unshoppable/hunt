/** `template` with every `{{name}}` replaced by `values[name]`; a placeholder without a value is a bug. */
export function fillPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`failed to fill the prompt: no value for ${placeholder}`);
    return value;
  });
}
