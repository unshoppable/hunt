/**
 * The ⌘F search of the dependency diagram. A file matches when every word of the query matches its path or one of the
 * identifiers in its content: the symbols it declares, imports and uses. Files whose name matches take precedence: while
 * there is one, the other files do not count; otherwise matches by path rank above matches by symbol. A word matches as a substring, ignoring case,
 * or fuzzily by camel humps and separators: each character either follows the previous one or starts a word, so
 * `wtss` finds `workingTimeSyncService` and `emp-imp` finds `employee-import.service.ts`.
 */

import { isBoundary } from "../ide/search/file-search.utils";
import { commands } from "../ipc/commands";
import { baseName } from "../common/path/path.utils";

/** What a file matches by: every word its name, every word its path, or some word only an identifier of its content. */
export type MatchKind = "name" | "path" | "symbol";

/** The order matches are visited in; the lower comes first. */
export const MATCH_KIND_RANK: Record<MatchKind, number> = { name: 0, path: 1, symbol: 2 };

const IDENTIFIER = /[A-Za-z_$][\w$]+/g;
const SEPARATORS = /[\/\-_. ]/g;

/** The distinct identifiers of `content` with at least two characters. */
export function identifiersOf(content: string): Set<string> {
  return new Set(content.match(IDENTIFIER));
}

/** The identifiers of each file at `paths` in the worktree; a file that cannot be read (deleted, binary) has none. */
export async function readIdentifiers(sessionId: string, paths: readonly string[]): Promise<Map<string, Set<string>>> {
  const entries = await Promise.all(
    paths.map(async (path) => [path, await commands.readFile(sessionId, path).then(identifiersOf, () => new Set<string>())] as const),
  );
  return new Map(entries);
}

/** Whether `word` (lower case) is a substring of `text`, ignoring case, or matches it by camel humps and separators. */
export function matchesWord(text: string, word: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(word)) return true;
  // A separator in the word only marks that the next character starts a word, which every hump may do anyway.
  const humps = word.replace(SEPARATORS, "");
  if (!humps) return false;
  // States (word index, text index) known to fail, so a text with many word starts is not searched twice from one.
  const failed = new Set<number>();
  const matchFrom = (wordIndex: number, textIndex: number): boolean => {
    if (wordIndex === humps.length) return true;
    const state = wordIndex * (text.length + 1) + textIndex;
    if (failed.has(state)) return false;
    const char = humps[wordIndex];
    if (wordIndex > 0 && lower[textIndex] === char && matchFrom(wordIndex + 1, textIndex + 1)) return true;
    for (let index = lower.indexOf(char, textIndex); index >= 0; index = lower.indexOf(char, index + 1)) {
      if (isBoundary(text, index) && matchFrom(wordIndex + 1, index + 1)) return true;
    }
    failed.add(state);
    return false;
  };
  return matchFrom(0, 0);
}

/**
 * The paths of `paths` matching `query` and what each matches by, with the identifiers of each file's content from
 * `identifiersByPath`; a file without an entry matches by its path only. Only files matching by name while there are
 * any. Null while the query is empty.
 */
export function searchDiagramFiles(paths: readonly string[], identifiersByPath: ReadonlyMap<string, ReadonlySet<string>>, query: string): Map<string, MatchKind> | null {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const matches = new Map<string, MatchKind>();
  for (const path of paths) {
    const kind = matchKindOf(path, identifiersByPath.get(path), words);
    if (kind) {
      matches.set(path, kind);
    }
  }
  const byName = [...matches].filter(([, kind]) => kind === "name");
  return byName.length ? new Map(byName) : matches;
}

function matchKindOf(path: string, identifiers: ReadonlySet<string> | undefined, words: readonly string[]): MatchKind | null {
  const name = baseName(path);
  if (words.every((word) => matchesWord(name, word))) return "name";
  if (words.every((word) => matchesWord(path, word))) return "path";
  const identifierList = [...(identifiers ?? [])];
  const isMatch = words.every((word) => matchesWord(path, word) || identifierList.some((identifier) => matchesWord(identifier, word)));
  return isMatch ? "symbol" : null;
}
