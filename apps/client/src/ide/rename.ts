/** Pure logic of the Rename refactoring (⌘Ü, see RenameDialog.tsx and `planRename` in languageService.ts). */

import type { Range, TextDocumentEdit, TextEdit, WorkspaceEdit } from "./lsp/protocol";
import { isImportLine, uriKey, usageOnLine } from "./usages";

/**
 * Where an occurrence was found, in the order the preview lists them: references the language server resolved, the
 * name in comments and string literals of source files, and the name in every other file (Markdown, JSON, HTML, …).
 */
export type OccurrenceGroup = "code" | "comment" | "text";

export const OCCURRENCE_GROUPS: readonly OccurrenceGroup[] = ["code", "comment", "text"];

/** WebStorm's headings of the preview's groups. */
export const GROUP_LABELS: Record<OccurrenceGroup, string> = {
  code: "Code usages to be renamed",
  comment: "Usages in comments and strings",
  text: "Text occurrences",
};

/** A 1-based range as Monaco counts lines and columns. */
export type OccurrenceRange = { line: number; column: number; endLine: number; endColumn: number };

/** One place a rename changes: the range becomes `newText`. */
export type RenameOccurrence = OccurrenceRange & {
  /** Unique within a rename: `path:line:column`. */
  key: string;
  group: OccurrenceGroup;
  path: string;
  newText: string;
  /** The first line's text without its indentation, and the 0-based offsets of the replaced range inside it. */
  text: string;
  matchStart: number;
  matchEnd: number;
};

/** A token of a line as `monaco.editor.tokenize` returns it; it runs from `offset` to the next token's offset. */
export type LineToken = { offset: number; type: string };

/** A whole-word match on a line: the 0-based line index and the match's start offset. */
export type WordMatch = { line: number; offset: number };

/** The occurrence replacing `range` of the file `path` with `newText`; `lineText` is the text of the range's first line. */
export function occurrenceAt(group: OccurrenceGroup, path: string, range: OccurrenceRange, newText: string, lineText: string): RenameOccurrence {
  const endColumn = range.endLine === range.line ? range.endColumn : lineText.length + 1;
  const { text, matchStart, matchEnd } = usageOnLine(path, range.line, range.column, endColumn, lineText, "");
  return { key: `${path}:${range.line}:${range.column}`, group, path, ...range, newText, text, matchStart, matchEnd };
}

/** The occurrence replacing a whole-word match of `word` on the 0-based line `match.line` of `lines`. */
export function wordOccurrence(group: OccurrenceGroup, path: string, lines: readonly string[], match: WordMatch, word: string, newText: string): RenameOccurrence {
  const line = match.line + 1;
  const range = { line, column: match.offset + 1, endLine: line, endColumn: match.offset + 1 + word.length };
  return occurrenceAt(group, path, range, newText, lines[match.line] ?? "");
}

const QUICK_INFO_KEYWORDS: Record<string, string> = {
  type: "type",
  interface: "interface",
  class: "class",
  enum: "enum",
  function: "function",
  const: "const",
  let: "let",
  var: "var",
  module: "module",
  namespace: "module",
  import: "alias",
};

/**
 * TypeScript's element kind of the symbol a hover describes, from the quick info line: `(property) A.b: string` →
 * `property`, `type A = …` → `type`, `(alias) class A` → `class`, `const enum E` → `enum`. Empty when the line names
 * no kind.
 */
export function quickInfoKind(quickInfo: string): string {
  const text = quickInfo.trim().replace(/^\(alias\)\s+/, "");
  const parenthesized = /^\(([a-z][a-z ]*)\)/.exec(text);
  if (parenthesized) return parenthesized[1];
  if (/^(?:declare\s+)?const\s+enum\b/.test(text)) return "enum";
  const keyword = /^(?:declare\s+)?([a-z]+)\b/.exec(text)?.[1];
  return (keyword && QUICK_INFO_KEYWORDS[keyword]) ?? "";
}

/** Whether `name` is a JavaScript identifier, or a private name (`#count`). */
export function isIdentifier(name: string): boolean {
  return /^#?[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(name);
}

/** Words that cannot name a variable, function, class or type in strict-mode TypeScript. */
const RESERVED_WORDS = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in " +
    "instanceof new null return super switch this throw true try typeof var void while with implements interface let package private " +
    "protected public static yield await"
  ).split(" "),
);

/** Element kinds whose names may be reserved words (`options.default`, `{ class: 1 }`). */
const MEMBER_KINDS = new Set(["property", "method", "getter", "setter", "enum member"]);

/**
 * Why `name` cannot replace `oldName`, the name of a symbol of TypeScript's element `kind`, or null when it can. The
 * language server renames to any text, so this is the only check. Names that were no identifiers are not checked (the
 * caller skips string literal types, whose values may look like identifiers); a private name stays private.
 */
export function nameProblem(name: string, oldName: string, kind: string): string | null {
  if (!isIdentifier(oldName)) return null;
  if (!isIdentifier(name) || name.startsWith("#") !== oldName.startsWith("#")) return `'${name}' is not a valid identifier.`;
  if (!MEMBER_KINDS.has(kind) && RESERVED_WORDS.has(name)) return `'${name}' is a reserved word.`;
  return null;
}

/** Whether the worktree path `path` lies in an installed package, which a rename must not change. */
export function isPackagePath(path: string): boolean {
  return path.split("/").includes("node_modules");
}

/** A language server error as the backend reports it (`-32803: You cannot rename this element.`), without the code. */
export function serverErrorMessage(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.replace(/^-?\d+:\s*/, "");
}

const IDENTIFIER_PART = /[\p{ID_Continue}$\u200C\u200D]/u;

/** Start offsets of `word` in `lineText` where it stands as a whole word, not as part of a longer identifier. */
export function wordOffsets(lineText: string, word: string): number[] {
  const offsets: number[] = [];
  if (!word) return offsets;
  for (let offset = lineText.indexOf(word); offset !== -1; offset = lineText.indexOf(word, offset + word.length)) {
    const before = lineText[offset - 1];
    const after = lineText[offset + word.length];
    if ((before && IDENTIFIER_PART.test(before)) || (after && IDENTIFIER_PART.test(after))) continue;
    offsets.push(offset);
  }
  return offsets;
}

/** Whole-word matches of `word` in `lines`. */
export function wordMatches(lines: readonly string[], word: string): WordMatch[] {
  return lines.flatMap((lineText, line) => wordOffsets(lineText, word).map((offset) => ({ line, offset })));
}

/** Whether the token covering `offset` of a tokenized line is a comment or a string literal. */
export function isCommentOrString(tokens: readonly LineToken[], offset: number): boolean {
  let covering: LineToken | undefined;
  for (const token of tokens) {
    if (token.offset > offset) break;
    covering = token;
  }
  return !!covering && (covering.type.startsWith("comment") || covering.type.startsWith("string"));
}

/**
 * The matches of `word` that lie in comments and string literals of a tokenized source file. Strings of import and
 * re-export statements are module paths and stay out.
 */
export function commentAndStringMatches(lines: readonly string[], tokens: readonly (readonly LineToken[])[], word: string): WordMatch[] {
  return wordMatches(lines, word).filter((match) => isCommentOrString(tokens[match.line] ?? [], match.offset) && !isImportLine(lines, match.line + 1));
}

/** The text edits of a workspace edit per document URI, from `changes` or from `documentChanges`; file operations are left out. */
export function editsByUri(edit: WorkspaceEdit | null | undefined): Map<string, TextEdit[]> {
  const result = new Map<string, TextEdit[]>();
  if (!edit) return result;
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      result.set(uri, [...(result.get(uri) ?? []), ...edits]);
    }
    return result;
  }
  for (const change of edit.documentChanges ?? []) {
    if (!("textDocument" in change)) continue;
    const document = change as TextDocumentEdit;
    result.set(document.textDocument.uri, [...(result.get(document.textDocument.uri) ?? []), ...document.edits]);
  }
  return result;
}

/** Whether `left` starts before `right` ends and `right` before `left` ends. */
function rangesOverlap(left: Range, right: Range): boolean {
  const isBefore = (first: Range["start"], second: Range["start"]) => first.line < second.line || (first.line === second.line && first.character < second.character);
  return isBefore(left.start, right.end) && isBefore(right.start, left.end);
}

/**
 * The TypeScript server's rename edits plus the Angular server's edits that touch none of them (the ones in
 * templates), per document URI; URIs that differ only in their escapes count as one document.
 */
export function mergeRenameEdits(typescript: Map<string, TextEdit[]>, angular: Map<string, TextEdit[]>): Map<string, TextEdit[]> {
  const result = new Map(typescript);
  const uris = new Map([...typescript.keys()].map((uri) => [uriKey(uri), uri]));
  for (const [uri, edits] of angular) {
    const known = uris.get(uriKey(uri)) ?? uri;
    const existing = result.get(known) ?? [];
    const added = edits.filter((edit) => !existing.some((other) => rangesOverlap(edit.range, other.range)));
    if (!added.length) continue;
    result.set(known, [...existing, ...added]);
    uris.set(uriKey(uri), known);
  }
  return result;
}

/** Whether two occurrences of the same file overlap. */
function overlaps(left: RenameOccurrence, right: RenameOccurrence): boolean {
  const isBefore = (line: number, column: number, otherLine: number, otherColumn: number) => line < otherLine || (line === otherLine && column < otherColumn);
  return left.path === right.path && isBefore(left.line, left.column, right.endLine, right.endColumn) && isBefore(right.line, right.column, left.endLine, left.endColumn);
}

/**
 * `occurrences` in the preview's order (group, path, line, column), without text matches at places the language
 * server already renames.
 */
export function mergeOccurrences(occurrences: readonly RenameOccurrence[]): RenameOccurrence[] {
  const code = occurrences.filter((occurrence) => occurrence.group === "code");
  const merged = occurrences.filter((occurrence) => occurrence.group === "code" || !code.some((reference) => overlaps(reference, occurrence)));
  const order = (group: OccurrenceGroup) => OCCURRENCE_GROUPS.indexOf(group);
  return merged.sort(
    (left, right) => order(left.group) - order(right.group) || left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column,
  );
}

/** `12 usages in 4 files`, `1 usage in 1 file`, `No usages`. */
export function occurrenceSummary(occurrences: readonly RenameOccurrence[]): string {
  if (!occurrences.length) return "No usages";
  const files = new Set(occurrences.map((occurrence) => occurrence.path)).size;
  return `${occurrences.length} ${occurrences.length === 1 ? "usage" : "usages"} in ${files} ${files === 1 ? "file" : "files"}`;
}
