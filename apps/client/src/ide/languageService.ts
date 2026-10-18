import * as monaco from "monaco-editor";
import type { Workspace } from "./documents";
import { lspClientForModel, type LspClient } from "./lsp/client";
import { asLocationLinks, elementKindOf, hoverSignature, rangeContains, symbolsAt, toLspPosition, toMonacoRange, type DocumentSymbol, type Hover, type Location, type LocationLink, type Position } from "./lsp/protocol";
import { containerOf, FUNCTION_KINDS, isImportLine, isSourceFile, parameterTypesOf, sortUsages, usageOnLine, type Usage } from "./usages";

export type DefinitionTarget = { uri: monaco.Uri; range: monaco.IRange };

/**
 * The symbol declared at a ⌘clicked position: `kind` is TypeScript's element kind (`class`, `method`, …),
 * `signature` the parameter types of a function-like declaration (`(any, string)`) for the popup title.
 */
export type Declaration = { name: string; kind: string; containerName: string; signature?: string };

/** What a ⌘click does: jump to the declaration elsewhere, or list the usages of the declaration under the click. */
export type Navigation = { type: "definition"; target: DefinitionTarget } | { type: "declaration"; declaration: Declaration };

export type SymbolCrumb = { name: string; kind: string };

function documentPosition(model: monaco.editor.ITextModel, position: Position) {
  return { textDocument: { uri: model.uri.toString() }, position };
}

/**
 * The ⌘click action for `position`, resolved by the language server: the usages when the click sits on the
 * name of a declaration (a definition's selection range contains the position), otherwise the first definition
 * inside the worktree to jump to. Null for files the server does not serve, positions without a symbol, or
 * declarations outside the worktree.
 */
export async function navigationAt(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<Navigation | null> {
  const client = lspClientForModel(model);
  if (!client) return null;
  const at = toLspPosition(position);
  const links = asLocationLinks(await client.request<LocationLink[] | Location[] | null>("textDocument/definition", documentPosition(model, at)));
  const own = model.uri.toString();
  for (const link of links) {
    if (link.targetUri !== own || !rangeContains(link.targetSelectionRange, at)) continue;
    return { type: "declaration", declaration: await declarationAt(client, model, at) };
  }
  for (const link of links) {
    const uri = monaco.Uri.parse(link.targetUri);
    if (!isInside(uri, client)) continue;
    return { type: "definition", target: { uri, range: toMonacoRange(link.targetSelectionRange) } };
  }
  return null;
}

export type FilePosition = { path: string; line: number; column: number };

/**
 * Where a ⌘click on `name` at `position` of the worktree file `path` lands, for clicks outside the editor (diffs)
 * whose text may differ from the file: the declaration when the language server knows one elsewhere inside the
 * worktree, otherwise the clicked position itself (the click sits on the declaration, the file has another word
 * there, or the server does not serve the file), so the click always opens the editor.
 */
export async function resolveDefinition(workspace: Workspace, path: string, position: monaco.IPosition, name: string): Promise<FilePosition> {
  const clicked = { path, line: position.lineNumber, column: position.column };
  const { model } = await workspace.open(path);
  if (model.getWordAtPosition(position)?.word !== name) return clicked;
  const navigation = await navigationAt(model, position).catch(() => null);
  if (navigation?.type !== "definition") return clicked;
  const targetPath = workspace.pathOf(navigation.target.uri);
  if (!targetPath) return clicked;
  return { path: targetPath, line: navigation.target.range.startLineNumber, column: navigation.target.range.startColumn };
}

function isInside(uri: monaco.Uri, client: LspClient): boolean {
  return uri.scheme === "file" && uri.path.startsWith(`${client.worktreePath}/`);
}

/** The declaration whose name is at `position`, from the document symbols; the signature comes from the hover text. */
async function declarationAt(client: LspClient, model: monaco.editor.ITextModel, position: Position): Promise<Declaration> {
  const path = symbolsAt(await client.documentSymbols(model), position);
  const symbol = path[path.length - 1];
  const container = path[path.length - 2];
  const name = symbol?.name ?? model.getWordAtPosition({ lineNumber: position.line + 1, column: position.character + 1 })?.word ?? "";
  const kind = symbol ? elementKindOf(symbol.kind) : "";
  const declaration: Declaration = { name, kind, containerName: container?.name ?? "" };
  if (FUNCTION_KINDS.has(kind)) {
    const hover = await client.request<Hover | null>("textDocument/hover", documentPosition(model, position)).catch(() => null);
    const signature = hover ? parameterTypesOf(hoverSignature(hover)) : null;
    if (signature) {
      declaration.signature = signature;
    }
  }
  return declaration;
}

/**
 * Every reference to the symbol at `position` across the project, without the declaration itself and without
 * import or re-export statements (they only repeat the usages in the file). The files holding references are
 * loaded into the workspace, so the popup can preview them.
 */
export async function findUsages(workspace: Workspace, model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<Usage[]> {
  const client = lspClientForModel(model);
  if (!client) return [];
  const params = { ...documentPosition(model, toLspPosition(position)), context: { includeDeclaration: false } };
  const references = (await client.request<Location[] | null>("textDocument/references", params)) ?? [];

  const byPath = new Map<string, Location[]>();
  for (const reference of references) {
    const path = workspace.pathOf(monaco.Uri.parse(reference.uri));
    if (!path || !isSourceFile(path)) continue;
    const list = byPath.get(path);
    if (list) {
      list.push(reference);
    } else {
      byPath.set(path, [reference]);
    }
  }

  const perFile = await Promise.all(
    [...byPath].map(async ([path, locations]) => {
      const document = await workspace.open(path).catch(() => null);
      if (!document) return [];
      const target = document.model;
      const symbols = await client.documentSymbols(target).catch(() => [] as DocumentSymbol[]);
      const lines = target.getLinesContent();
      const usages: Usage[] = [];
      for (const location of locations) {
        const range = toMonacoRange(location.range);
        if (isImportLine(lines, range.startLineNumber)) continue;
        const crumbs = symbolsAt(symbols, location.range.start).map((symbol) => ({ name: symbol.name, kind: elementKindOf(symbol.kind) }));
        const container = containerOf(crumbs);
        usages.push(usageOnLine(path, range.startLineNumber, range.startColumn, range.endColumn, lines[range.startLineNumber - 1] ?? "", container?.name ?? "", container?.kind ?? ""));
      }
      return usages;
    }),
  );
  return sortUsages(perFile.flat());
}

/**
 * The declarations enclosing `position`, outermost first (`UserRepository` › `searchPage`), from the server's
 * document symbols. Empty for files the server does not serve and positions outside every declaration.
 */
export async function symbolPathAt(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<SymbolCrumb[]> {
  const client = lspClientForModel(model);
  if (!client) return [];
  const symbols = await client.documentSymbols(model);
  return symbolsAt(symbols, toLspPosition(position)).map((symbol) => ({ name: symbol.name, kind: elementKindOf(symbol.kind) }));
}
