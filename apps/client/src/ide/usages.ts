import type { HighlightedLine } from "../code/highlight";
import { rangeContains, type Location, type Position } from "./lsp/protocol";

/** One reference to a symbol, ready for the usages popup (columns are 1-based like Monaco's). */
export type Usage = {
  path: string;
  line: number;
  column: number;
  endColumn: number;
  /** The line's text without leading whitespace. */
  text: string;
  /** 0-based offsets of the referenced name inside `text`. */
  matchStart: number;
  matchEnd: number;
  /** Name of the innermost declaration containing the usage (`injectCatalogSearchResults`), empty at top level. */
  container: string;
  /** TypeScript's element kind of that declaration (`class`, `function`, …), empty at top level. */
  containerKind: string;
};

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Whether the TypeScript worker can analyse `path`. */
export function isSourceFile(path: string): boolean {
  return SOURCE_FILE.test(path);
}

/** Whether the usages popup lists references in `path`: source files and the HTML templates of Angular components. */
export function isUsageFile(path: string): boolean {
  return isSourceFile(path) || /\.html$/.test(path);
}

/** A URI as a comparable key: both servers encode the same path, but not necessarily with the same escapes. */
export function uriKey(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

function locationKey(location: Location): string {
  return `${uriKey(location.uri)}:${location.range.start.line}:${location.range.start.character}`;
}

/**
 * The references of the TypeScript server plus those only the Angular server knows (the ones in templates). The
 * Angular server lists the declaration even when asked not to, so its references containing the asked `position` of
 * the document `uri` are left out.
 */
export function mergeReferences(typescript: readonly Location[], angular: readonly Location[], uri: string, position: Position): Location[] {
  const known = new Set(typescript.map(locationKey));
  const isDeclaration = (location: Location) => uriKey(location.uri) === uriKey(uri) && rangeContains(location.range, position);
  return [...typescript, ...angular.filter((location) => !known.has(locationKey(location)) && !isDeclaration(location))];
}

/** Builds a usage from a line's full text: trims the indentation and shifts the match offsets accordingly. */
export function usageOnLine(path: string, line: number, column: number, endColumn: number, lineText: string, container: string, containerKind = ""): Usage {
  const indent = lineText.length - lineText.trimStart().length;
  return {
    path,
    line,
    column,
    endColumn,
    text: lineText.trimStart().trimEnd(),
    matchStart: Math.max(0, column - 1 - indent),
    matchEnd: Math.max(0, endColumn - 1 - indent),
    container,
    containerKind,
  };
}

/** Element kinds the usages popup names as the enclosing declaration of a usage; variables and fields inside them do not count. */
const CONTAINER_KINDS = new Set(["class", "local class", "interface", "enum", "module", "function", "local function", "method", "constructor", "getter", "setter"]);

/**
 * The declaration the usages popup shows as a usage's container: the innermost enclosing class, function or
 * method, like WebStorm. `crumbs` are the declarations around the usage, outermost first; undefined at top level
 * or when only variables and fields enclose the usage.
 */
export function containerOf<T extends { kind: string }>(crumbs: readonly T[]): T | undefined {
  for (let index = crumbs.length - 1; index >= 0; index--) {
    if (CONTAINER_KINDS.has(crumbs[index].kind)) return crumbs[index];
  }
  return undefined;
}

/** Element kinds whose popup title carries the parameter types (`Method search(any, any)`), like WebStorm. */
export const FUNCTION_KINDS = new Set(["function", "local function", "method", "constructor"]);

const OPENING = new Set(["(", "[", "{", "<"]);
const CLOSING = new Set([")", "]", "}", ">"]);

/**
 * The parameter types of the function signature in TypeScript's quick info text, formatted like WebStorm's popup
 * titles: `(method) Queries.search(a: Foo, b?: string, ...rest: any[]): void` → `(Foo, string, any[])`. Null when the
 * text holds no parameter list.
 */
export function parameterTypesOf(quickInfo: string): string | null {
  const text = quickInfo.replace(/^\([a-z ]+\)\s+/, "");
  const open = text.indexOf("(");
  if (open === -1) return null;
  const parameters: string[] = [];
  let depth = 0;
  let start = open + 1;
  let index = open + 1;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === "=" && text[index + 1] === ">") {
      index++;
      continue;
    }
    if (OPENING.has(char)) {
      depth++;
    } else if (CLOSING.has(char)) {
      if (depth === 0) break;
      depth--;
    } else if (char === "," && depth === 0) {
      parameters.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (index >= text.length) return null;
  parameters.push(text.slice(start, index));
  const types = parameters.map(parameterType).filter((type) => type);
  return `(${types.join(", ")})`;
}

/** The type after the parameter's top-level `:`, or the whole parameter when it has no annotation. */
function parameterType(parameter: string): string {
  let depth = 0;
  for (let index = 0; index < parameter.length; index++) {
    const char = parameter[index];
    if (OPENING.has(char)) {
      depth++;
    } else if (CLOSING.has(char)) {
      depth--;
    } else if (char === ":" && depth === 0) {
      return parameter.slice(index + 1).trim();
    }
  }
  return parameter.trim();
}

/** The part of a highlighted line between the character offsets `from` and `to`, keeping the runs' styles. */
export function sliceRuns(runs: HighlightedLine, from: number, to: number): HighlightedLine {
  const result: HighlightedLine = [];
  let offset = 0;
  for (const run of runs) {
    const start = offset;
    offset += run.text.length;
    const text = run.text.slice(Math.max(0, from - start), Math.max(0, Math.min(run.text.length, to - start)));
    if (text) {
      result.push({ text, style: run.style });
    }
  }
  return result;
}

const IMPORT_START = /^\s*(import\b|export\s+(type\s+)?(\*|\{))/;
const STATEMENT_END = /;\s*$|\bfrom\s+['"]/;

/**
 * Whether line `line` (1-based) of `lines` belongs to an import or re-export statement, including the inner lines
 * of a multi-line `import {\n  a,\n} from '…'`. The statement is found by walking up to its first line; a line
 * ending an earlier statement stops the walk.
 */
export function isImportLine(lines: readonly string[], line: number): boolean {
  for (let index = line - 1; index >= 0; index--) {
    const text = lines[index];
    if (IMPORT_START.test(text)) return index === line - 1 || !STATEMENT_END.test(text);
    if (index !== line - 1 && STATEMENT_END.test(text)) return false;
    if (!text.trim() && index !== line - 1) return false;
  }
  return false;
}

/** Usages ordered by path, then line, then column, so the list reads file by file. */
export function sortUsages(usages: Usage[]): Usage[] {
  return [...usages].sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column);
}

/** `index` moved by `delta` rows, stopping at the first and last row. */
export function stepSelection(index: number, delta: number, count: number): number {
  if (!count) return -1;
  return Math.min(count - 1, Math.max(0, index + delta));
}

const KIND_LABELS: Record<string, string> = {
  class: "Class",
  interface: "Interface",
  type: "Type alias",
  enum: "Enum",
  "enum member": "Enum member",
  function: "Function",
  "local function": "Function",
  method: "Method",
  property: "Property",
  getter: "Getter",
  setter: "Setter",
  constructor: "Constructor",
  const: "Constant",
  let: "Variable",
  var: "Variable",
  "local var": "Variable",
  parameter: "Parameter",
  "type parameter": "Type parameter",
  alias: "Alias",
  module: "Module",
};

/** WebStorm's label for a TypeScript element kind (`method` → `Method`); unknown kinds are capitalised. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Symbol");
}

/** `3 usages`, `1 usage`, `No usages` for the popup header. */
export function usageCountLabel(count: number): string {
  if (!count) return "No usages";
  return `${count} ${count === 1 ? "usage" : "usages"}`;
}
