/**
 * Symbol results of the file search (⌘P / double shift), like the classes and symbols of WebStorm's "Search Everywhere":
 * the language server's workspace symbols, which cover only the projects of files it has open, completed by the
 * unindented declarations a text search finds in every source file, so a class of a project nobody opened is found too.
 */

import type { TextMatch, TextQuery } from "./find-in-files.types";
import { NAME_MATCH_BONUS, matchText, type FileMatch } from "./file-search.utils";
import { elementKindOf, type WorkspaceSymbol } from "../lsp/lsp-protocol.utils";

/** A declaration found by the language server or the text search; `line` and `column` are 1-based and point at the name. */
export type SymbolCandidate = { name: string; kind: string; containerName: string; path: string; line: number; column: number };

/** A candidate matching the query; `positions` index into `name`. */
export type SymbolMatch = SymbolCandidate & { score: number; positions: number[] };

/** Kinds WebStorm lists as "Classes", in a group of their own before the files. */
export const CLASS_KINDS = new Set(["class", "interface", "type", "enum"]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const SOURCE_FILE_MASK = "*.ts, *.tsx, *.mts, *.cts, *.js, *.jsx, *.mjs, *.cjs, !*.min.js";

/** An unindented declaration (`export abstract class Name`), with the keyword and the name as groups 1 and 2. */
const DECLARATION = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|function\*?|const|let|var|namespace)\s+([\w$]+)/;

const KEYWORD_KINDS: Record<string, string> = { "function*": "function", namespace: "module" };

/** Whether `text` can name a symbol; other queries (paths, file names with dots) search files only. */
export function isSymbolQuery(text: string): boolean {
  return IDENTIFIER.test(text);
}

/** The Find in Files query for the source files mentioning `text` anywhere, ignoring case. */
export function mentionQuery(text: string): TextQuery {
  return { text, matchCase: false, wholeWords: false, isRegex: false, fileMask: SOURCE_FILE_MASK };
}

/** The Find in Files query for the unindented declarations whose name contains `text`, ignoring case. */
export function declarationQuery(text: string): TextQuery {
  const name = `[\\w$]*${text.replace(/\$/g, () => "\\$")}[\\w$]*`;
  return { text: DECLARATION.source.replace("([\\w$]+)", `(${name})`), matchCase: false, wholeWords: false, isRegex: true, fileMask: SOURCE_FILE_MASK };
}

/** The declarations on the lines a `declarationQuery` matched. */
export function declarationsOf(matches: readonly TextMatch[]): SymbolCandidate[] {
  const candidates: SymbolCandidate[] = [];
  for (const match of matches) {
    const start = match.ranges[0]?.start ?? 0;
    const declaration = DECLARATION.exec(match.preview.slice(start));
    if (!declaration) continue;
    const [whole, keyword, name] = declaration;
    const nameStart = whole.length - name.length;
    candidates.push({ name, kind: KEYWORD_KINDS[keyword] ?? keyword, containerName: "", path: match.path, line: match.line, column: match.column + nameStart });
  }
  return candidates;
}

/** The workspace symbols declared in `files` (worktree-relative paths), which leaves out libraries and generated output. */
export function workspaceSymbolsIn(symbols: readonly WorkspaceSymbol[], worktreePath: string, files: ReadonlySet<string>): SymbolCandidate[] {
  const prefix = `${worktreePath}/`;
  const candidates: SymbolCandidate[] = [];
  for (const symbol of symbols) {
    if (!("range" in symbol.location) || !symbol.location.uri.startsWith("file://")) continue;
    const absolutePath = decodeURIComponent(new URL(symbol.location.uri).pathname);
    const path = absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : null;
    if (!path || !files.has(path)) continue;
    const { start } = symbol.location.range;
    candidates.push({ name: symbol.name, kind: elementKindOf(symbol.kind), containerName: symbol.containerName ?? "", path, line: start.line + 1, column: start.character + 1 });
  }
  return candidates;
}

/**
 * Ranks the candidates whose name matches `query` like file names (see file-search.utils.ts); a declaration found twice
 * counts once. Ties go to classes, then to shorter names. The best `limit` matches come first.
 */
export function rankSymbols(candidates: readonly SymbolCandidate[], query: string, limit = 30): SymbolMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const seen = new Set<string>();
  const matches: SymbolMatch[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.path}:${candidate.line}:${candidate.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const match = matchText(candidate.name, needle);
    if (!match) continue;
    matches.push({ ...candidate, ...match });
  }
  const classRank = (match: SymbolMatch) => (CLASS_KINDS.has(match.kind) ? 0 : 1);
  matches.sort(
    (left, right) =>
      right.score - left.score || classRank(left) - classRank(right) || left.name.length - right.name.length || left.path.localeCompare(right.path) || left.line - right.line,
  );
  return matches.slice(0, limit);
}

/** A result of the file search: a file or a symbol. */
export type SearchResult = { type: "file"; match: FileMatch } | { type: "symbol"; match: SymbolMatch };

/** The group a result is listed under. */
export function resultGroup(result: SearchResult): "Classes" | "Files" | "Symbols" {
  if (result.type === "file") return "Files";
  return CLASS_KINDS.has(result.match.kind) ? "Classes" : "Symbols";
}

/** A result's score on the scale of `searchFiles`: a symbol matches by its name, like a file matched by its name. */
function resultScore(result: SearchResult): number {
  return result.type === "file" ? result.match.score : NAME_MATCH_BONUS + result.match.score;
}

/**
 * Lists the classes, the files and the other symbols in groups, each in the order given, and puts the group with the
 * best match first, so a symbol named like the query comes before files that match only loosely. Groups whose best
 * matches tie keep the order of WebStorm's "Search Everywhere": classes, files, symbols.
 */
export function mergeResults(files: readonly FileMatch[], symbols: readonly SymbolMatch[]): SearchResult[] {
  const symbolResults = symbols.map((match): SearchResult => ({ type: "symbol", match }));
  const groups = [
    symbolResults.filter((result) => resultGroup(result) === "Classes"),
    files.map((match): SearchResult => ({ type: "file", match })),
    symbolResults.filter((result) => resultGroup(result) === "Symbols"),
  ];
  const bestScore = (group: SearchResult[]) => Math.max(...group.map(resultScore));
  return groups.sort((left, right) => bestScore(right) - bestScore(left)).flat();
}
