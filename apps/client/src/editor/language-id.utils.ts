/** Monaco language ids by file extension and by the names used in Markdown fences. */
const LANGUAGE_BY_NAME: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  json: "json",
  jsonc: "json",
  rs: "rust",
  rust: "rust",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  zsh: "shell",
  bash: "shell",
  shell: "shell",
  console: "shell",
  py: "python",
  python: "python",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  go: "go",
  java: "java",
  kt: "kotlin",
  kotlin: "kotlin",
  xml: "xml",
  graphql: "graphql",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  text: "plaintext",
  txt: "plaintext",
  plain: "plaintext",
  plaintext: "plaintext",
};

/** Monaco language id for a file path. */
export function monacoLanguage(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_NAME[extension] ?? "plaintext";
}

/**
 * Monaco language id for the info string of a Markdown fence (`ts`, `bash`, `TypeScript title="x"`). Names
 * without an alias are passed through, so Monaco's other grammars (`cpp`, `ruby`, …) still apply.
 */
export function monacoLanguageForFence(info: string | undefined): string {
  const name = info?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!name) return "plaintext";
  return LANGUAGE_BY_NAME[name] ?? name;
}
