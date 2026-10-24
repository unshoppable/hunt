/**
 * The ⌘F search of the dependency diagram. A file matches when every word of the query matches its path or one of the
 * identifiers in its content: the symbols it declares, imports and uses. A word matches as a substring, ignoring case,
 * or fuzzily by camel humps and separators: each character either follows the previous one or starts a word, so
 * `wtss` finds `workingTimeSyncService` and `emp-imp` finds `employee-import.service.ts`.
 */

import { isBoundary } from "../ide/fileSearch";
import { commands } from "../ipc/commands";

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
 * The paths of `paths` matching `query`, with the identifiers of each file's content from `identifiersByPath`; a file
 * without an entry matches by its path only. Null while the query is empty.
 */
export function searchDiagramFiles(paths: readonly string[], identifiersByPath: ReadonlyMap<string, ReadonlySet<string>>, query: string): Set<string> | null {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const matches = new Set<string>();
  for (const path of paths) {
    const identifiers = [...(identifiersByPath.get(path) ?? [])];
    const isMatch = words.every((word) => matchesWord(path, word) || identifiers.some((identifier) => matchesWord(identifier, word)));
    if (isMatch) {
      matches.add(path);
    }
  }
  return matches;
}
