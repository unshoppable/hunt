import * as monaco from "monaco-editor";
import { TokenizationRegistry } from "monaco-editor/editor/common/languages.js";
import { vs_dark } from "monaco-editor/editor/standalone/common/themes.js";
import { setupMonaco } from "./setup.monaco";
import { classifyModel, semanticTokenName, type SemanticSpan } from "./semantic-tokens.monaco";
import { WEBSTORM, WEBSTORM_TOKEN_RULES } from "./webstorm-scheme.monaco";
import { createTokenStyleResolver, type TokenStyle } from "./token-style.utils";
import { excerptSpans } from "./excerpt.utils";

setupMonaco();

/** A stretch of one line with one style. */
export type CodeRun = { text: string; style: TokenStyle };

/** One line of code as consecutive runs; empty for a blank line. */
export type HighlightedLine = CodeRun[];

/**
 * The token theme of the Monaco editors (see setup.monaco.ts): the `vs-dark` base, the editor foreground as the default
 * token color and the WebStorm rules on top, resolved like Monaco resolves them.
 */
const resolveStyle = createTokenStyleResolver([...vs_dark.rules, { token: "", foreground: WEBSTORM.TEXT }, ...WEBSTORM_TOKEN_RULES]);

const SEMANTIC_LANGUAGES = new Set(["typescript", "javascript"]);

let modelCount = 0;

/**
 * Grammars a language embeds (see webstorm-scheme.monaco.ts and angular-template.monaco.ts); they must be loaded along with it,
 * since the embedded stretches stay plain otherwise.
 */
const EMBEDDED_LANGUAGES: Record<string, string[]> = {
  typescript: ["html", "css"],
  javascript: ["html", "css"],
  html: ["javascript", "css"],
};

/** Whether the grammar of `language` and those it embeds are loaded, so `tokenizeCode` can run synchronously. */
export function hasTokenizer(language: string): boolean {
  return [language, ...(EMBEDDED_LANGUAGES[language] ?? [])].every((entry) => TokenizationRegistry.get(entry) !== null);
}

/**
 * Loads the grammar of `language` and those it embeds; resolves to false when Monaco has none for it. Languages
 * whose tokenizer ships with their rich language features (JSON) only register it once a model of the language
 * exists, so a throwaway model triggers that and the registry change is awaited.
 */
export async function loadTokenizer(language: string): Promise<boolean> {
  const isLoaded = await loadOwnTokenizer(language);
  await Promise.all((EMBEDDED_LANGUAGES[language] ?? []).map(loadOwnTokenizer));
  return isLoaded;
}

async function loadOwnTokenizer(language: string): Promise<boolean> {
  if (await TokenizationRegistry.getOrCreate(language)) return true;
  if (!monaco.languages.getLanguages().some((entry) => entry.id === language)) return false;
  const model = monaco.editor.createModel("", language);
  try {
    return await new Promise<boolean>((resolve) => {
      const finish = (isLoaded: boolean) => {
        clearTimeout(timeout);
        listener.dispose();
        resolve(isLoaded);
      };
      const timeout = setTimeout(() => finish(false), 5000);
      const listener = TokenizationRegistry.onDidChange((event) => {
        if (event.changedLanguages.includes(language)) {
          finish(TokenizationRegistry.get(language) !== null);
        }
      });
      if (TokenizationRegistry.get(language) !== null) {
        finish(true);
      }
    });
  } finally {
    model.dispose();
  }
}

function pushRun(runs: HighlightedLine, text: string, style: TokenStyle): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.style === style) {
    last.text += text;
    return;
  }
  runs.push({ text, style });
}

/**
 * Colors `text` with the Monarch grammar of `language` and the editor theme; lines are split at `\n` only, so
 * they line up with the lines of a diff. Null until the grammar is loaded (see `loadTokenizer`) and for
 * languages Monaco has no grammar for.
 */
export function tokenizeCode(text: string, language: string): HighlightedLine[] | null {
  const support = TokenizationRegistry.get(language);
  if (!support) return null;
  const lines: HighlightedLine[] = [];
  let state = support.getInitialState();
  for (const line of text.split("\n")) {
    const result = support.tokenize(line, true, state);
    state = result.endState;
    const runs: HighlightedLine = [];
    for (let index = 0; index < result.tokens.length; index++) {
      const token = result.tokens[index];
      const end = index + 1 < result.tokens.length ? result.tokens[index + 1].offset : line.length;
      pushRun(runs, line.slice(token.offset, end), resolveStyle(token.type));
    }
    lines.push(runs);
  }
  return lines;
}

/** Whether code of `language` gets semantic colors on top of its grammar's (see `classifyCode`). */
export function hasSemanticColors(language: string): boolean {
  return SEMANTIC_LANGUAGES.has(language);
}

/**
 * Semantic classifications of a TypeScript or JavaScript `text` (see semantic-tokens.monaco.ts), computed on a throwaway
 * model; `path` decides between TS and TSX parsing. Empty for other languages or when the worker fails.
 */
export async function classifyCode(text: string, language: string, path?: string): Promise<SemanticSpan[]> {
  if (!hasSemanticColors(language)) return [];
  const extension = path?.match(/\.(tsx|jsx|ts|js|mts|cts|mjs|cjs)$/)?.[1] ?? (language === "typescript" ? "ts" : "js");
  const model = monaco.editor.createModel(text, language, monaco.Uri.parse(`inmemory://highlight/${++modelCount}.${extension}`));
  try {
    return (await classifyModel(model)) ?? [];
  } finally {
    model.dispose();
  }
}

/**
 * Semantic classifications of `text`, a copy of the lines of the TypeScript or JavaScript `model` from `startLine` on,
 * taken from the classification of the whole file, so names declared or imported outside the copy get their roles too
 * (see `excerptSpans`). Null for other languages, when the lines no longer match or when the worker fails.
 */
export async function classifyExcerpt(text: string, model: monaco.editor.ITextModel, startLine: number): Promise<SemanticSpan[] | null> {
  const spans = await classifyModel(model);
  return spans ? excerptSpans(model.getValue(), spans, text, startLine) : null;
}

/** Replaces the style of `[from, to)` within the runs of one line. */
function restyle(runs: HighlightedLine, from: number, to: number, style: TokenStyle): HighlightedLine {
  const result: HighlightedLine = [];
  let offset = 0;
  for (const run of runs) {
    const start = offset;
    const end = offset + run.text.length;
    offset = end;
    if (end <= from || start >= to) {
      pushRun(result, run.text, run.style);
      continue;
    }
    pushRun(result, run.text.slice(0, Math.max(0, from - start)), run.style);
    pushRun(result, run.text.slice(Math.max(0, from - start), Math.min(run.text.length, to - start)), style);
    pushRun(result, run.text.slice(Math.min(run.text.length, to - start)), run.style);
  }
  return result;
}

/** Overrides the grammar colors of `lines` (from `tokenizeCode` on `text`) with the semantic classifications, like the editor does. */
export function applySemanticSpans(lines: HighlightedLine[], text: string, spans: SemanticSpan[]): HighlightedLine[] {
  if (!spans.length) return lines;
  const lineLengths = text.split("\n").map((line) => line.length);
  const result = lines.slice();
  let lineIndex = 0;
  let lineStart = 0;
  for (const span of spans) {
    while (lineIndex < lineLengths.length - 1 && span.start > lineStart + lineLengths[lineIndex]) {
      lineStart += lineLengths[lineIndex] + 1;
      lineIndex++;
    }
    const from = span.start - lineStart;
    result[lineIndex] = restyle(result[lineIndex], from, from + span.length, resolveStyle(semanticTokenName(span)));
  }
  return result;
}
