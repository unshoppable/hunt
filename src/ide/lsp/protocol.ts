import type * as monaco from "monaco-editor";

/** The subset of the Language Server Protocol the editor uses; positions are 0-based, UTF-16 code units. */
export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type Location = { uri: string; range: Range };
export type LocationLink = { originSelectionRange?: Range; targetUri: string; targetRange: Range; targetSelectionRange: Range };
export type MarkupContent = { kind: "plaintext" | "markdown"; value: string };
export type Hover = { contents: MarkupContent | string | (string | { language: string; value: string })[]; range?: Range };
export type InlayHintLabelPart = { value: string; tooltip?: string | MarkupContent };
export type InlayHint = { position: Position; label: string | InlayHintLabelPart[]; kind?: 1 | 2; paddingLeft?: boolean; paddingRight?: boolean };
export type DocumentHighlight = { range: Range; kind?: 1 | 2 | 3 };
export type DocumentSymbol = { name: string; detail?: string; kind: number; range: Range; selectionRange: Range; children?: DocumentSymbol[] };
export type Diagnostic = { range: Range; severity?: 1 | 2 | 3 | 4; code?: number | string; source?: string; message: string; tags?: number[] };
export type DocumentDiagnosticReport = { kind: "full"; items: Diagnostic[] } | { kind: "unchanged" };
export type TextDocumentContentChangeEvent = { range: Range; text: string } | { text: string };
export type TextEdit = { range: Range; newText: string };
export type InsertReplaceEdit = { newText: string; insert: Range; replace: Range };
export type CompletionItemLabelDetails = { detail?: string; description?: string };
export type CompletionItem = {
  label: string;
  labelDetails?: CompletionItemLabelDetails;
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | MarkupContent;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /** 1 plain text, 2 snippet. */
  insertTextFormat?: 1 | 2;
  textEdit?: TextEdit | InsertReplaceEdit;
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  data?: unknown;
};
/** Values shared by the items of a list that leave them out. */
export type CompletionItemDefaults = { commitCharacters?: string[]; editRange?: Range | { insert: Range; replace: Range }; insertTextFormat?: 1 | 2; data?: unknown };
export type CompletionList = { isIncomplete: boolean; itemDefaults?: CompletionItemDefaults; items: CompletionItem[] };
export type ParameterInformation = { label: string | [number, number]; documentation?: string | MarkupContent };
export type SignatureInformation = { label: string; documentation?: string | MarkupContent; parameters?: ParameterInformation[]; activeParameter?: number };
export type SignatureHelp = { signatures: SignatureInformation[]; activeSignature?: number; activeParameter?: number };

/** LSP `SymbolKind` values, named after the protocol's enum. */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file",
  2: "module",
  3: "module",
  4: "module",
  5: "class",
  6: "method",
  7: "property",
  8: "property",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "var",
  14: "const",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum member",
  23: "class",
  24: "event",
  25: "operator",
  26: "type parameter",
};

/** TypeScript's element kind name for an LSP symbol kind (`method`, `class`, `const`), as the usages popup and icons know them. */
export function elementKindOf(symbolKind: number): string {
  return SYMBOL_KIND_NAMES[symbolKind] ?? "";
}

export function toLspPosition(position: monaco.IPosition): Position {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toMonacoPosition(position: Position): monaco.IPosition {
  return { lineNumber: position.line + 1, column: position.character + 1 };
}

export function toMonacoRange(range: Range): monaco.IRange {
  return { startLineNumber: range.start.line + 1, startColumn: range.start.character + 1, endLineNumber: range.end.line + 1, endColumn: range.end.character + 1 };
}

export function toLspRange(range: monaco.IRange): Range {
  return { start: { line: range.startLineNumber - 1, character: range.startColumn - 1 }, end: { line: range.endLineNumber - 1, character: range.endColumn - 1 } };
}

function isBefore(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

/** Whether `position` lies within `range` (both ends inclusive). */
export function rangeContains(range: Range, position: Position): boolean {
  return !isBefore(position, range.start) && !isBefore(range.end, position);
}

/** Monaco's incremental content changes as LSP content changes, in Monaco's order (last change first, so earlier ranges stay valid). */
export function toContentChanges(event: monaco.editor.IModelContentChangedEvent): TextDocumentContentChangeEvent[] {
  return event.changes.map((change) => ({ range: toLspRange(change.range), text: change.text }));
}

/** The hover text as Markdown, whatever shape the server chose for `contents`. */
export function hoverMarkdown(hover: Hover): string {
  const { contents } = hover;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((part) => (typeof part === "string" ? part : `\`\`\`${part.language}\n${part.value}\n\`\`\``)).join("\n\n");
  }
  return contents.kind === "markdown" ? contents.value : "```\n" + contents.value + "\n```";
}

/** The code of the first fenced block of a hover (TypeScript's quick info line), or the plain text when there is no fence. */
export function hoverSignature(hover: Hover): string {
  const markdown = hoverMarkdown(hover);
  const fenced = markdown.match(/```[^\n]*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : markdown).trim();
}

/** The declarations enclosing `position`, outermost first, from a document symbol tree. */
export function symbolsAt(symbols: readonly DocumentSymbol[] | undefined, position: Position): DocumentSymbol[] {
  const path: DocumentSymbol[] = [];
  let level = symbols;
  while (level) {
    const next = level.find((symbol) => rangeContains(symbol.range, position));
    if (!next) break;
    path.push(next);
    level = next.children;
  }
  return path;
}

/** Definition results come as links or plain locations depending on the server; both become links. */
export function asLocationLinks(result: LocationLink | LocationLink[] | Location | Location[] | null | undefined): LocationLink[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.map((item) =>
    "targetUri" in item ? item : { targetUri: item.uri, targetRange: item.range, targetSelectionRange: item.range },
  );
}

/** Monaco's `CompletionItemKind` value for each LSP `CompletionItemKind` (1-based), as numbers so this module stays free of Monaco's runtime. */
const COMPLETION_KINDS: monaco.languages.CompletionItemKind[] = [
  18, // Text
  0, // Method
  1, // Function
  2, // Constructor
  3, // Field
  4, // Variable
  5, // Class
  7, // Interface
  8, // Module
  9, // Property
  12, // Unit
  13, // Value
  15, // Enum
  17, // Keyword
  28, // Snippet
  19, // Color
  20, // File
  21, // Reference
  23, // Folder
  16, // EnumMember
  14, // Constant
  6, // Struct
  10, // Event
  11, // Operator
  24, // TypeParameter
];

/** Monaco's `CompletionItemInsertTextRule.InsertAsSnippet` and `CompletionItemTag.Deprecated`. */
const INSERT_AS_SNIPPET = 4 as monaco.languages.CompletionItemInsertTextRule;
const DEPRECATED = 1 as monaco.languages.CompletionItemTag;

/** Monaco's completion kind for an LSP `CompletionItemKind`; unknown kinds show as plain text. */
export function toMonacoCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  return (kind && COMPLETION_KINDS[kind - 1]) ?? COMPLETION_KINDS[0];
}

/** Documentation of a completion item or signature as Monaco renders it (Markdown). */
export function toMarkdown(documentation: string | MarkupContent | undefined): monaco.IMarkdownString | undefined {
  if (!documentation) return undefined;
  if (typeof documentation === "string") return { value: documentation };
  return { value: documentation.kind === "markdown" ? documentation.value : "```\n" + documentation.value + "\n```" };
}

function toMonacoCompletionRange(edit: TextEdit | InsertReplaceEdit | CompletionItemDefaults["editRange"] | undefined): monaco.IRange | monaco.languages.CompletionItemRanges | undefined {
  if (!edit) return undefined;
  if ("insert" in edit) return { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
  if ("range" in edit) return toMonacoRange(edit.range);
  return toMonacoRange(edit);
}

/**
 * A Monaco completion item for an LSP one: the server's edit (or the list's default edit range, or the word before
 * `position`) decides what the item replaces, snippets keep their placeholders, and the LSP item travels along in
 * `lsp` so `completionItem/resolve` can be asked for documentation and auto-import edits.
 */
export function toMonacoCompletion(item: CompletionItem, defaults: CompletionItemDefaults | undefined, wordRange: monaco.IRange): monaco.languages.CompletionItem & { lsp: CompletionItem } {
  const format = item.insertTextFormat ?? defaults?.insertTextFormat;
  const deprecated = item.deprecated || item.tags?.includes(1);
  const resolved = resolvedFields(item);
  return {
    label: item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label,
    kind: toMonacoCompletionKind(item.kind),
    tags: deprecated ? [DEPRECATED] : undefined,
    preselect: item.preselect,
    sortText: item.sortText,
    filterText: item.filterText,
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    insertTextRules: format === 2 ? INSERT_AS_SNIPPET : undefined,
    range: toMonacoCompletionRange(item.textEdit ?? defaults?.editRange) ?? wordRange,
    commitCharacters: item.commitCharacters ?? defaults?.commitCharacters,
    ...resolved,
    lsp: { ...item, data: item.data ?? defaults?.data },
  };
}

/** The fields `completionItem/resolve` fills in later: documentation, detail and the edits an auto-import adds. */
export function resolvedFields(item: CompletionItem): Pick<monaco.languages.CompletionItem, "detail" | "documentation" | "additionalTextEdits"> {
  return {
    detail: item.detail,
    documentation: toMarkdown(item.documentation),
    additionalTextEdits: item.additionalTextEdits?.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText })),
  };
}

/** Monaco's signature help for the server's: parameter labels stay strings or `[start, end]` offsets into the signature. */
export function toMonacoSignatureHelp(help: SignatureHelp): monaco.languages.SignatureHelp {
  return {
    signatures: help.signatures.map((signature) => ({
      label: signature.label,
      documentation: toMarkdown(signature.documentation),
      parameters: (signature.parameters ?? []).map((parameter) => ({ label: parameter.label, documentation: toMarkdown(parameter.documentation) })),
      activeParameter: signature.activeParameter,
    })),
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0,
  };
}
