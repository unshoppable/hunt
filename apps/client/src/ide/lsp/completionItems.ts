import type { CompletionItem } from "./protocol";

/** What the `detail` of a resolved completion item says, split up for the suggestion row and the docs column. */
export type CompletionSignature = {
  /** The type declaring the member (`PropertyOptions<Owner>`), when the detail names one. */
  owner?: string;
  /** The declaration without its kind tag and owner (`nullable?: boolean | undefined`, `function rel<T>(a: T): T`). */
  signature: string;
  /** Parameter list of a callable without its type parameters (`(callbackfn: …, thisArg?: any)`). */
  parameters?: string;
  /** Type of a property or variable, return type of a callable. */
  type?: string;
};

/** LSP `CompletionItemKind.Keyword`. */
const KEYWORD_KIND = 14;
/** TypeScript's sort text of globals; keywords, auto-imports and deprecated items sort at or after it. */
const GLOBALS_SORT_TEXT = "15";
/** Kind tag TypeScript puts in front of a member's detail: `(property) `, `(method) `, `(local var) `. */
const KIND_TAG = /^\([a-z ]+\)\s+/;
/** First line of an auto-import's detail; the declaration follows on the next lines. */
const IMPORT_NOTE = /^(?:Auto|Update|Add) import from /;
/** Line TypeScript appends to an alias's detail. */
const ALIAS_IMPORT = /^import\s/;
const OVERLOADS = /\s*\(\+\d+ overloads?\)$/;
const DECLARATION_KEYWORD = /^(?:declare\s+)?(?:function|const|let|var|class|interface|type|enum|module|namespace|get|set)\s+/;
/** Characters that may follow a declared name: optional marker, type annotation, parameters, value or end. */
const AFTER_NAME = /^(?:$|[?:(<\s=])/;

/** The item's name as the row shows it: an optional member's trailing `?` goes, its type says `| undefined` anyway. */
export function completionName(item: Pick<CompletionItem, "label">): string {
  return item.label.endsWith("?") ? item.label.slice(0, -1) : item.label;
}

/**
 * Splits the `detail` TypeScript resolves for the completion item `name` into its parts, e.g.
 * `(property) PropertyOptions<X>.nullable?: boolean | undefined` into owner `PropertyOptions<X>`, signature
 * `nullable?: boolean | undefined` and type `boolean | undefined`. A detail spread over several lines (an object type)
 * is folded into one. Null for a detail without a declaration (keywords, a bare import note).
 */
export function parseCompletionDetail(detail: string, name: string): CompletionSignature | null {
  const lines = detail.split("\n");
  const declaration = (IMPORT_NOTE.test(lines[0]) ? lines.slice(1) : lines).filter((line) => !ALIAS_IMPORT.test(line));
  const folded = declaration.join("\n").replace(/\s*\n\s*/g, " ").trim().replace(KIND_TAG, "").replace(OVERLOADS, "");
  const keyword = DECLARATION_KEYWORD.exec(folded)?.[0] ?? "";
  const rest = folded.slice(keyword.length);
  const nameAt = nameIndex(rest, name);
  if (nameAt < 0) return null;
  const owner = nameAt > 0 ? rest.slice(0, nameAt - 1) : undefined;
  const after = rest.slice(nameAt + name.length);
  if (!after && !keyword) return null;

  const signature: CompletionSignature = { owner, signature: keyword + name + after };
  const annotation = after.startsWith("?") ? after.slice(1) : after;
  if (annotation.startsWith(":")) {
    signature.type = annotation.slice(1).trim();
  } else if (annotation.startsWith("<") || annotation.startsWith("(")) {
    const parametersAt = annotation.startsWith("<") ? closingIndex(annotation, 0) + 1 : 0;
    const parametersEnd = closingIndex(annotation, parametersAt);
    if (parametersAt > 0 && annotation[parametersAt] !== "(") return signature;
    if (parametersEnd < 0) return signature;
    signature.parameters = annotation.slice(parametersAt, parametersEnd + 1);
    const returnType = annotation.slice(parametersEnd + 1).trim();
    if (returnType.startsWith(":")) {
      signature.type = returnType.slice(1).trim();
    }
  }
  return signature;
}

/** Index of `name` as the declared name in `text`: at its start, or after the owner and a dot; -1 when it is neither. */
function nameIndex(text: string, name: string): number {
  if (text.startsWith(name) && AFTER_NAME.test(text.slice(name.length))) return 0;
  for (let at = text.indexOf(`.${name}`); at >= 0; at = text.indexOf(`.${name}`, at + 1)) {
    if (AFTER_NAME.test(text.slice(at + 1 + name.length))) return at + 1;
  }
  return -1;
}

/** Index of the bracket closing the `(` or `<` at `start`; the `>` of an arrow `=>` does not count. -1 when unclosed. */
function closingIndex(text: string, start: number): number {
  const open = text[start];
  const close = open === "(" ? ")" : ">";
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === open) {
      depth++;
    } else if (character === close && !(close === ">" && text[index - 1] === "=")) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Whether a completion list holds only members of one type: an object literal's or a destructuring pattern's
 * properties, or a value's members after a dot. Such lists carry no keywords and nothing sorted with the globals.
 */
export function isMemberList(items: Pick<CompletionItem, "kind" | "sortText">[]): boolean {
  return items.length > 0 && items.every((item) => item.kind !== KEYWORD_KIND && (item.sortText ?? "") < GLOBALS_SORT_TEXT);
}

/**
 * Indexes of `items` in the order the suggest widget probably lists them while `word` is typed: items starting with
 * it, by sort text and then by label like Monaco's own comparison. The first of them are the rows visible at first.
 */
export function likelyVisibleOrder(items: Pick<CompletionItem, "label" | "filterText" | "sortText">[], word: string): number[] {
  const prefix = word.toLowerCase();
  const indexes = items.flatMap((item, index) => (!prefix || (item.filterText ?? item.label).toLowerCase().startsWith(prefix) ? [index] : []));
  return indexes.sort((left, right) => compareText(items[left].sortText ?? "", items[right].sortText ?? "") || compareText(items[left].label, items[right].label));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
