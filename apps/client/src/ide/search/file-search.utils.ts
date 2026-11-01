/**
 * Matching and ranking for the file search (⌘P / double shift), modelled on WebStorm's "Go to File": a query without
 * `/` is matched against file names first and whole paths second, a query with `/` against the file name with its last
 * part and against the directories with the rest; a trailing `:line` requests a caret position, whitespace in the
 * query is ignored.
 *
 * A match is the best alignment of the query's characters in the text, scored like fzf's and nucleo's: points per
 * matched character, a bonus for one that starts a word (after a separator, a camel hump, a digit run), more for a
 * run of adjacent characters, a penalty per gap. File names get boosts for an exact name, a name without its
 * extension and a prefix, and a query with capitals one for its exact case; a name match outranks every path match.
 * The ranking follows OpenIDEA's `crates/ide-index/src/matching.rs` (Apache-2.0).
 */

export type FileMatch = {
  path: string;
  name: string;
  /** Directory part of `path`, empty for root files. */
  dir: string;
  score: number;
  /** Indexes into `path` of the characters the query matched, for highlighting. */
  positions: number[];
};

export type ParsedQuery = { text: string; line: number | null };

/** Added to the score of a match in the file name, which ranks it above every match in the directories. */
export const NAME_MATCH_BONUS = 1 << 20;

/** Points per matched character. */
const SCORE_MATCH = 16;
/** Penalty of a gap's first skipped character and of every further one. */
const GAP_START = 3;
const GAP_EXTENSION = 1;
/** The least bonus of a character right after the previous match. */
const BONUS_CONSECUTIVE = 4;
/** Bonuses of a character starting the text, following a `/`, following another separator, or starting a camel hump or digit run. */
const BONUS_START = 10;
const BONUS_SLASH = 9;
const BONUS_SEPARATOR = 8;
const BONUS_CAMEL = 7;
/** The first matched character's bonus counts this often. */
const FIRST_CHAR_MULTIPLIER = 2;
/** Boosts of a file name equal to the query, equal to it without its extension, or starting with it. */
const BOOST_EXACT = 1000;
const BOOST_STEM = 800;
const BOOST_PREFIX = 150;
/** Added to a boosted name when a query holding capitals is its exact prefix. */
const BOOST_CASE = 50;
const NONE = -(1 << 30);

/** Splits `ward-edit:42` into the search text and the requested line; the line is `null` when absent or invalid. */
export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  const match = /^(.*?):(\d+)$/.exec(trimmed);
  if (!match) return { text: trimmed, line: null };
  const line = Number(match[2]);
  return { text: match[1], line: line > 0 ? line : null };
}

/** Whether `text[index]` starts a word: the first character, one after a separator or an upper-case letter after a lower-case one. */
export function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1];
  if (previous === "/" || previous === "-" || previous === "_" || previous === "." || previous === " ") return true;
  const current = text[index];
  return current !== current.toLowerCase() && previous === previous.toLowerCase();
}

/** `text` lower-cased unit by unit, so that every index stays valid (`"İ".toLowerCase()` has two units). */
function lowerCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let units = "";
  for (const unit of text) {
    const lowered = unit.toLowerCase();
    units += lowered.length === unit.length ? lowered : unit;
  }
  return units;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiLetterOrDigit(code: number): boolean {
  return isDigit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isUpper(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code < 128) return code >= 65 && code <= 90;
  return text[index] !== text[index].toLowerCase();
}

function isLower(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code < 128) return code >= 97 && code <= 122;
  return text[index] !== text[index].toUpperCase();
}

/** The bonus of a match at `text[index]` in a text that starts at `start`. */
function bonusAt(text: string, index: number, start: number): number {
  if (index === start) return BONUS_START;
  const previous = text.charCodeAt(index - 1);
  if (previous === 47) return BONUS_SLASH;
  if (previous < 128 && !isAsciiLetterOrDigit(previous)) return BONUS_SEPARATOR;
  if (isLower(text, index - 1) && isUpper(text, index)) return BONUS_CAMEL;
  if (!isDigit(previous) && isDigit(text.charCodeAt(index))) return BONUS_CAMEL;
  return 0;
}

/** Buffers of `align`, grown on demand and shared by every call, as the search runs once per keystroke and path. */
let codes = new Uint16Array(256);
let bonuses = new Uint8Array(256);
let rows = [new Int32Array(256), new Int32Array(256)];
let chunks = [new Uint8Array(256), new Uint8Array(256)];
let predecessors = new Int32Array(4096);
/** Per needle character the first and the last window index it can match at. */
let lows = new Int32Array(64);
let highs = new Int32Array(64);

type Alignment = { score: number; positions: number[] };

/**
 * The best alignment of `needle` (lower-cased, no whitespace) in `text.slice(start, end)`, `lower` being `text`
 * lower-cased; `null` when `needle` is no subsequence of it. The positions index into `text` and are traced only
 * `withPositions`. fzf's dynamic programme over the window from the needle's first possible start to its last possible
 * end: `rows[i % 2][k]` is the best score of the needle's first `i + 1` characters with the last one at window index
 * `k`, computed only between the first and the last index that character can take; a run of adjacent matches keeps
 * the bonus of its best character (`chunks`).
 */
function align(text: string, lower: string, start: number, end: number, needle: string, withPositions: boolean): Alignment | null {
  const length = needle.length;
  if (lows.length < length) {
    lows = new Int32Array(length * 2);
    highs = new Int32Array(length * 2);
  }
  let cursor = start;
  for (let index = 0; index < length; index++) {
    const found = lower.indexOf(needle[index], cursor);
    if (found < 0 || found >= end) return null;
    lows[index] = found;
    cursor = found + 1;
  }
  cursor = end;
  for (let index = length - 1; index >= 0; index--) {
    cursor = lower.lastIndexOf(needle[index], cursor - 1);
    highs[index] = cursor;
  }
  const first = lows[0];
  const width = highs[length - 1] - first + 1;
  for (let index = 0; index < length; index++) {
    lows[index] -= first;
    highs[index] -= first;
  }
  if (codes.length < width) {
    codes = new Uint16Array(width * 2);
    bonuses = new Uint8Array(width * 2);
    rows = [new Int32Array(width * 2), new Int32Array(width * 2)];
    chunks = [new Uint8Array(width * 2), new Uint8Array(width * 2)];
  }
  if (withPositions && predecessors.length < width * length) {
    predecessors = new Int32Array(width * length * 2);
  }
  for (let offset = 0; offset < width; offset++) {
    codes[offset] = lower.charCodeAt(first + offset);
    bonuses[offset] = bonusAt(text, first + offset, start);
  }

  let previous = rows[0];
  let previousChunks = chunks[0];
  const head = needle.charCodeAt(0);
  for (let offset = 0; offset <= highs[0]; offset++) {
    const bonus = bonuses[offset];
    previous[offset] = codes[offset] === head ? SCORE_MATCH + bonus * FIRST_CHAR_MULTIPLIER : NONE;
    previousChunks[offset] = bonus;
  }
  for (let index = 1; index < length; index++) {
    const current = rows[index % 2];
    const currentChunks = chunks[index % 2];
    const code = needle.charCodeAt(index);
    const previousLow = lows[index - 1];
    const previousHigh = highs[index - 1];
    const low = lows[index];
    // The best score of the previous character two or more places back, less the extensions of the gap since then.
    let gapBest = NONE;
    let gapAt = -1;
    for (let offset = previousLow + 1; offset <= highs[index]; offset++) {
      if (offset - 2 >= previousLow) {
        gapBest -= GAP_EXTENSION;
        if (offset - 2 <= previousHigh && previous[offset - 2] > gapBest) {
          gapBest = previous[offset - 2];
          gapAt = offset - 2;
        }
      }
      if (offset < low) continue;
      if (codes[offset] !== code) {
        current[offset] = NONE;
        continue;
      }
      const bonus = bonuses[offset];
      const before = offset - 1 <= previousHigh ? previous[offset - 1] : NONE;
      const consecutive = before > NONE ? before + SCORE_MATCH + Math.max(bonus, BONUS_CONSECUTIVE, previousChunks[offset - 1]) : NONE;
      const gap = gapBest > NONE / 2 ? gapBest - GAP_START + SCORE_MATCH + bonus : NONE;
      if (consecutive === NONE && gap === NONE) {
        current[offset] = NONE;
      } else if (consecutive >= gap) {
        current[offset] = consecutive;
        currentChunks[offset] = Math.max(bonus, previousChunks[offset - 1]);
        if (withPositions) {
          predecessors[index * width + offset] = offset - 1;
        }
      } else {
        current[offset] = gap;
        currentChunks[offset] = bonus;
        if (withPositions) {
          predecessors[index * width + offset] = gapAt;
        }
      }
    }
    previous = current;
    previousChunks = currentChunks;
  }

  let score = NONE;
  let last = -1;
  for (let offset = lows[length - 1]; offset <= highs[length - 1]; offset++) {
    if (previous[offset] > score) {
      score = previous[offset];
      last = offset;
    }
  }
  if (last < 0) return null;
  if (!withPositions) return { score, positions: [] };
  const positions = new Array<number>(length);
  for (let index = length - 1; index >= 0; index--) {
    positions[index] = first + last;
    last = predecessors[index * width + last];
  }
  return { score, positions };
}

/** A query ready for matching: without whitespace, lower-cased, and whether it holds capitals. */
type Needle = { text: string; lower: string; hasCapitals: boolean };

function needleOf(query: string): Needle {
  const text = query.replace(/\s+/g, "");
  const lower = lowerCase(text);
  return { text, lower, hasCapitals: lower !== text };
}

/** The boost of the name `text.slice(start)` for `needle`: exact, without its extension or prefix, plus exact case. */
function nameBoost(text: string, lower: string, start: number, needle: Needle): number {
  if (!lower.startsWith(needle.lower, start)) return 0;
  const end = start + needle.lower.length;
  let boost = BOOST_PREFIX;
  if (end === lower.length) {
    boost = BOOST_EXACT;
  } else if (lower[end] === "." && (end === lower.indexOf(".", start + 1) || end === lower.lastIndexOf("."))) {
    boost = BOOST_STEM;
  }
  return needle.hasCapitals && text.startsWith(needle.text, start) ? boost + BOOST_CASE : boost;
}

/** The match of `needle` in the name `text.slice(start)` (a file's or a symbol's), traced only `withPositions`. */
function matchNameAt(text: string, lower: string, start: number, needle: Needle, withPositions: boolean): Alignment | null {
  const alignment = align(text, lower, start, lower.length, needle.lower, withPositions);
  if (!alignment) return null;
  return { score: alignment.score + nameBoost(text, lower, start, needle), positions: alignment.positions };
}

/** Matches `query` against a name such as a symbol's, scored like a file name without `NAME_MATCH_BONUS`; `positions` index into `name`. */
export function matchName(name: string, query: string): Alignment | null {
  const needle = needleOf(query);
  if (!needle.lower) return null;
  return matchNameAt(name, lowerCase(name), 0, needle, true);
}

/** A listed path with its lower-cased twin and where its name starts, prepared once per list. */
type PreparedPath = { path: string; lower: string; nameStart: number };

const preparedLists = new WeakMap<readonly string[], PreparedPath[]>();

function prepare(paths: readonly string[]): PreparedPath[] {
  let prepared = preparedLists.get(paths);
  if (!prepared) {
    prepared = paths.map((path) => ({ path, lower: lowerCase(path), nameStart: path.lastIndexOf("/") + 1 }));
    preparedLists.set(paths, prepared);
  }
  return prepared;
}

/** A path among the best matches so far; `isName` when it matched by its name. */
type Candidate = { entry: PreparedPath; score: number; isName: boolean };

/** Whether `left` ranks before `right`: higher score, then shorter path, then path order. */
function ranksBefore(left: Candidate, right: Candidate): boolean {
  if (left.score !== right.score) return left.score > right.score;
  if (left.entry.path.length !== right.entry.path.length) return left.entry.path.length < right.entry.path.length;
  return left.entry.path < right.entry.path;
}

/** Inserts `candidate` into the ranked `best` when it belongs to its first `limit`. */
function keepBest(best: Candidate[], candidate: Candidate, limit: number) {
  if (best.length >= limit && !ranksBefore(candidate, best[best.length - 1])) return;
  let index = best.length;
  while (index > 0 && ranksBefore(candidate, best[index - 1])) {
    index--;
  }
  best.splice(index, 0, candidate);
  if (best.length > limit) {
    best.pop();
  }
}

/**
 * Ranks `paths` against `query`; the best `limit` matches come first. An empty query matches nothing. A query with `/`
 * matches the file name with its part after the last `/` and the directories with the part before it.
 */
export function searchFiles(paths: readonly string[], query: string, limit = 50): FileMatch[] {
  const needle = needleOf(query);
  if (!needle.lower || limit <= 0) return [];
  const prepared = prepare(paths);
  const slash = needle.text.lastIndexOf("/");
  if (slash < 0) return searchNames(prepared, needle, limit);
  return searchPaths(prepared, needleOf(needle.text.slice(0, slash).replace(/^\/+/, "")), needleOf(needle.text.slice(slash + 1)), limit);
}

/** The best `limit` names matching `needle`, then, while there is room, the best paths matching it. */
function searchNames(prepared: readonly PreparedPath[], needle: Needle, limit: number): FileMatch[] {
  const best: Candidate[] = [];
  const unmatched: PreparedPath[] = [];
  for (const entry of prepared) {
    const byName = matchNameAt(entry.path, entry.lower, entry.nameStart, needle, false);
    if (byName) {
      keepBest(best, { entry, score: NAME_MATCH_BONUS + byName.score, isName: true }, limit);
    } else {
      unmatched.push(entry);
    }
  }
  // Path matches rank below every name match, so they count only while the name matches leave room.
  if (best.length < limit) {
    for (const entry of unmatched) {
      const byPath = align(entry.path, entry.lower, 0, entry.lower.length, needle.lower, false);
      if (byPath) {
        keepBest(best, { entry, score: byPath.score, isName: false }, limit);
      }
    }
  }
  return best.map(({ entry, score, isName }) => {
    const { path, lower, nameStart } = entry;
    return fileMatch(entry, score, isName ? matchNameAt(path, lower, nameStart, needle, true) : align(path, lower, 0, lower.length, needle.lower, true));
  });
}

/** The best `limit` paths whose name matches `name` and whose directories match `dir`. */
function searchPaths(prepared: readonly PreparedPath[], dir: Needle, name: Needle, limit: number): FileMatch[] {
  const best: Candidate[] = [];
  for (const entry of prepared) {
    const match = matchPath(entry, dir, name, false);
    if (match) {
      keepBest(best, { entry, score: match.score, isName: false }, limit);
    }
  }
  return best.map(({ entry, score }) => fileMatch(entry, score, matchPath(entry, dir, name, true)));
}

/** The match of `name` in the file name and of `dir` in the directories of `entry`; an empty needle matches anything. */
function matchPath(entry: PreparedPath, dir: Needle, name: Needle, withPositions: boolean): Alignment | null {
  const { path, lower, nameStart } = entry;
  const byName = name.lower ? matchNameAt(path, lower, nameStart, name, withPositions) : { score: 0, positions: [] };
  if (!byName) return null;
  if (!dir.lower) return byName;
  const byDir = nameStart > 0 ? align(path, lower, 0, nameStart - 1, dir.lower, withPositions) : null;
  if (!byDir) return null;
  return { score: byDir.score + byName.score, positions: [...byDir.positions, ...byName.positions] };
}

function fileMatch({ path, nameStart }: PreparedPath, score: number, alignment: Alignment | null): FileMatch {
  return { path, name: path.slice(nameStart), dir: nameStart ? path.slice(0, nameStart - 1) : "", score, positions: alignment?.positions ?? [] };
}
