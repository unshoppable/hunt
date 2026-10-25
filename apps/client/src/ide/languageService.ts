import * as monaco from "monaco-editor";
import { commands } from "../ipc/commands";
import type { Workspace } from "./documents";
import { lspClientForModel, lspClientForTemplate, type LspClient } from "./lsp/client";
import { monacoLanguage } from "../diff/monaco";
import { pathLiteralAt } from "../diff/pathLiteral";
import { asLocationLinks, elementKindOf, hoverSignature, rangeContains, symbolsAt, toLspPosition, toLspRange, toMonacoRange, type CodeAction, type DocumentSymbol, type Hover, type Location, type LocationLink, type Position, type Range, type TextEdit, type WorkspaceEdit, type WorkspaceSymbol } from "./lsp/protocol";
import { documentEdits } from "./reformat";
import { commentAndStringMatches, editsByUri, isPackagePath, mergeOccurrences, mergeRenameEdits, occurrenceAt, quickInfoKind, serverErrorMessage, wordMatches, wordOccurrence, type RenameOccurrence } from "./rename";
import { containerOf, FUNCTION_KINDS, isImportLine, isSourceFile, isUsageFile, mergeReferences, parameterTypesOf, sortUsages, usageOnLine, type Usage } from "./usages";

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
 * The ⌘click action for `position`: a relative path literal naming a worktree file (`templateUrl: './a.html'`, an
 * import specifier) opens that file. Otherwise the language server resolves it: the usages when the click sits on the
 * name of a declaration (a definition's selection range contains the position), otherwise the first definition
 * inside the worktree to jump to. The Angular language server answers for Angular templates and, where the TypeScript
 * server finds nothing, for a component's inline template: a tag or attribute leads to its component, directive,
 * input or output, a name in an expression to the component member. Null for files no server serves, positions
 * without a symbol, or declarations outside the worktree.
 */
export async function navigationAt(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<Navigation | null> {
  const file = await pathLiteralFile(model, position);
  if (file) return file;
  const at = toLspPosition(position);
  const client = lspClientForModel(model);
  if (!client) {
    const templateClient = lspClientForTemplate(model);
    return templateClient ? definitionInside(templateClient, await angularDefinitions(templateClient, model, at)) : null;
  }
  const links = asLocationLinks(await client.request<LocationLink[] | Location[] | null>("textDocument/definition", documentPosition(model, at)));
  const own = model.uri.toString();
  for (const link of links) {
    if (link.targetUri !== own || !rangeContains(link.targetSelectionRange, at)) continue;
    return { type: "declaration", declaration: await declarationAt(client, model, at) };
  }
  return definitionInside(client, links.length ? links : await angularDefinitions(client, model, at));
}

/**
 * The start of the worktree file the relative path literal at `position` names, resolved from the model's folder like
 * a relative import (`./user.service` finds `user.service.ts`); null outside such a literal or without that file.
 */
async function pathLiteralFile(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<Navigation | null> {
  const literal = pathLiteralAt(model.getLineContent(position.lineNumber), position.column);
  const client = lspClientForModel(model) ?? lspClientForTemplate(model);
  if (!literal || !client || !isInside(model.uri, client)) return null;
  const from = model.uri.path.slice(client.worktreePath.length + 1);
  const [path] = await commands.resolveImports(client.sessionId, from, [literal.path]).catch(() => [null]);
  if (!path) return null;
  const uri = monaco.Uri.file(`${client.worktreePath}/${path}`);
  return { type: "definition", target: { uri, range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } } };
}

/** The Angular language server's definitions at `position`; none when the worktree has no Angular server. */
async function angularDefinitions(client: LspClient, model: monaco.editor.ITextModel, position: Position): Promise<LocationLink[]> {
  const params = documentPosition(model, position);
  return asLocationLinks(await client.request<LocationLink[] | Location[] | null>("textDocument/definition", params, undefined, "angular").catch(() => null));
}

/** The jump to the first of `links` that lies inside the worktree; null without one. */
function definitionInside(client: LspClient, links: LocationLink[]): Navigation | null {
  for (const link of links) {
    const uri = monaco.Uri.parse(link.targetUri);
    if (!isInside(uri, client)) continue;
    return { type: "definition", target: { uri, range: toMonacoRange(link.targetSelectionRange) } };
  }
  return null;
}

export type FilePosition = { path: string; line: number; column: number };

/** Monaco's default `wordSeparators`, which make `findMatches` match whole words only. */
const WORD_SEPARATORS = "`~!@#$%^&*()-=+[{]}\\|;:'\",.<>/?";

/**
 * Where a ⌘click on `name` at `position` of the worktree file `path` lands, for clicks outside the editor (diffs)
 * whose text may differ from the file: the declaration when the language server knows one inside the worktree,
 * asked from the clicked position when the file has `name` there, else from its nearest other occurrence in the
 * file, else by name from the server's workspace symbols (the name left the file, e.g. with a deleted import).
 * A click on the declaration itself lands on that occurrence. Otherwise the clicked position (the worktree lost
 * the name, or the server does not serve the file), so the click always opens the editor.
 */
export async function resolveDefinition(workspace: Workspace, path: string, position: monaco.IPosition, name: string): Promise<FilePosition> {
  const clicked = { path, line: position.lineNumber, column: position.column };
  const { model } = await workspace.open(path);
  const occurrence = nearestOccurrence(model, position, name);
  const navigation = occurrence ? await navigationAt(model, occurrence).catch(() => null) : null;
  if (navigation?.type === "declaration" && occurrence) return { path, line: occurrence.lineNumber, column: occurrence.column };
  const target = navigation?.type === "definition" ? navigation.target : occurrence ? null : await workspaceDefinition(model, name).catch(() => null);
  const targetPath = target ? workspace.pathOf(target.uri) : null;
  if (!target || !targetPath) return clicked;
  return { path: targetPath, line: target.range.startLineNumber, column: target.range.startColumn };
}

/** `position` when the word there is `name`, else the whole-word occurrence of `name` on the line closest to it; null without one. */
function nearestOccurrence(model: monaco.editor.ITextModel, position: monaco.IPosition, name: string): monaco.IPosition | null {
  if (model.getWordAtPosition(position)?.word === name) return position;
  let nearest: monaco.IPosition | null = null;
  let distance = Infinity;
  for (const match of model.findMatches(name, false, false, true, WORD_SEPARATORS, false)) {
    const gap = Math.abs(match.range.startLineNumber - position.lineNumber);
    if (gap >= distance) continue;
    nearest = match.range.getStartPosition();
    distance = gap;
  }
  return nearest;
}

/** The declaration named exactly `name` inside the worktree, from the server's workspace symbols; null without one. */
async function workspaceDefinition(model: monaco.editor.ITextModel, name: string): Promise<DefinitionTarget | null> {
  const client = lspClientForModel(model);
  if (!client) return null;
  const symbols = (await client.request<WorkspaceSymbol[] | null>("workspace/symbol", { query: name })) ?? [];
  for (const symbol of symbols) {
    if (symbol.name !== name || !("range" in symbol.location)) continue;
    const uri = monaco.Uri.parse(symbol.location.uri);
    if (!isInside(uri, client)) continue;
    return { uri, range: toMonacoRange(symbol.location.range) };
  }
  return null;
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
 * import or re-export statements (they only repeat the usages in the file). Three searches run at once: the TypeScript
 * server's in its loaded projects, its search again once the projects of every file mentioning the name are loaded
 * (a worktree search), and the Angular language server's in component templates, which takes seconds while it loads
 * projects. `onUsages` gets the usages found so far whenever one of them ends, `isComplete` after the last. A failed
 * worktree search leaves the usages to the loaded projects. The files holding references are loaded into the
 * workspace, so the popup can preview them.
 */
export async function findUsages(
  workspace: Workspace,
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  onUsages: (usages: Usage[], isComplete: boolean) => void,
): Promise<void> {
  const client = lspClientForModel(model);
  if (!client) {
    onUsages([], true);
    return;
  }
  const at = toLspPosition(position);
  const params = { ...documentPosition(model, at), context: { includeDeclaration: false } };
  let typeScriptReferences: Location[] = [];
  let templateReferences: Location[] = [];
  let pendingSearches = 3;
  let reports = Promise.resolve();
  /** Hands the usages found so far to `onUsages` after the ones reported before; the last search completes them. */
  const report = () => {
    pendingSearches -= 1;
    const references = mergeReferences(typeScriptReferences, templateReferences, model.uri.toString(), at);
    const isComplete = !pendingSearches;
    reports = reports.then(async () => onUsages(await usagesOf(workspace, client, references), isComplete));
  };
  const searchTypeScript = async () => {
    typeScriptReferences = (await client.request<Location[] | null>("textDocument/references", params)) ?? [];
    report();
  };
  const name = model.getWordAtPosition(position)?.word;
  const projectsLoaded = name ? loadProjectsMentioning(client, name).catch(() => []) : Promise.resolve([]);
  const templateSearch = client
    .request<Location[] | null>("textDocument/references", params, undefined, "angular")
    .catch(() => null)
    .then((references) => {
      templateReferences = references ?? [];
      report();
    });
  await searchTypeScript();
  await projectsLoaded;
  await searchTypeScript();
  await templateSearch;
  await reports;
}

/** The usages at `references` in the worktree's source files and templates, sorted, without import lines. */
async function usagesOf(workspace: Workspace, client: LspClient, references: Location[]): Promise<Usage[]> {
  const byPath = new Map<string, Location[]>();
  for (const reference of references) {
    const path = workspace.pathOf(monaco.Uri.parse(reference.uri));
    if (!path || !isUsageFile(path)) continue;
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
 * Loads the TypeScript project of every worktree source file containing `name` as a whole word. tsgo searches
 * references only in the projects it has loaded, which are those of the open files, so a library's usages in an app
 * stay hidden until a file of the app is open; asked for a file's `custom/projectInfo`, it loads the file's project.
 * A server without that method answers with an error, which leaves the search to the loaded projects. Resolves with
 * the worktree paths of every file containing `name`, source files or not.
 */
export async function loadProjectsMentioning(client: LspClient, name: string): Promise<string[]> {
  const paths = await commands.searchWord(client.sessionId, name);
  await loadProjectsOf(client, paths);
  return paths;
}

/** Loads the TypeScript project of every source file among `paths` (worktree paths) into the server, as `loadProjectsMentioning` does. */
export async function loadProjectsOf(client: LspClient, paths: readonly string[]): Promise<void> {
  const uriOf = (path: string) => monaco.Uri.file(`${client.worktreePath}/${path}`).toString();
  const requests = paths.filter(isSourceFile).map((path) => client.request("custom/projectInfo", { textDocument: { uri: uriOf(path) } }).catch(() => null));
  await Promise.all(requests);
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

/** Code action kind of the language server's "Remove Unused Imports". */
const REMOVE_UNUSED_IMPORTS = "source.removeUnusedImports";

/** The language server's edits that remove the unused imports of `model`; none for models it does not serve. */
export async function unusedImportEdits(model: monaco.editor.ITextModel): Promise<TextEdit[]> {
  const client = lspClientForModel(model);
  if (!client) return [];
  const uri = model.uri.toString();
  const context = { diagnostics: [], only: [REMOVE_UNUSED_IMPORTS], triggerKind: 1 };
  const actions = await client.request<CodeAction[] | null>("textDocument/codeAction", { textDocument: { uri }, range: toLspRange(model.getFullModelRange()), context });
  return documentEdits(actions?.find((action) => action.kind === REMOVE_UNUSED_IMPORTS)?.edit, uri);
}

/** The language server's formatting edits for `model` with its indentation options; null for models it does not serve. */
export async function formattingEdits(model: monaco.editor.ITextModel): Promise<TextEdit[] | null> {
  const client = lspClientForModel(model);
  if (!client) return null;
  const { tabSize, insertSpaces } = model.getOptions();
  const edits = await client.request<TextEdit[] | null>("textDocument/formatting", { textDocument: { uri: model.uri.toString() }, options: { tabSize, insertSpaces } });
  return edits ?? [];
}

/**
 * The symbol a rename starts from: its name, TypeScript's element kind (`type`, `property`, …), whether the name is the
 * value of a string literal type, and the place the language server is asked to rename it from.
 */
export type RenameTarget = { name: string; kind: string; isStringLiteral: boolean; uri: string; position: Position };

/** Which matches of the old name a rename changes besides the references the language server resolves. */
export type RenameOptions = { commentsAndStrings: boolean; textOccurrences: boolean };

/** What a rename changes; `texts` holds the content of every file it edits as it was when the occurrences were found. */
export type RenamePlan = { name: string; newName: string; occurrences: RenameOccurrence[]; texts: Map<string, string> };

type PrepareRenameResult = Range | { range: Range; placeholder: string } | { defaultBehavior: boolean } | null;

const CANNOT_RENAME = "This element cannot be renamed.";

/**
 * The symbol at `position` the language server can rename, its kind read from the hover text. Rejects with the
 * server's reason when there is nothing to rename there (a keyword, a symbol of the standard library or a package).
 */
export async function renameTarget(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<RenameTarget> {
  const client = lspClientForModel(model);
  if (!client) throw new Error("Rename needs the TypeScript language server, which does not serve this file.");
  const uri = model.uri.toString();
  const at = toLspPosition(position);
  const prepared = await prepareRename(client, uri, at).catch((reason) => {
    throw new Error(serverErrorMessage(reason));
  });
  if (!prepared) throw new Error(CANNOT_RENAME);
  const range = toMonacoRange(prepared.range);
  const text = model.getValueInRange(range);
  // The server offers `this` and `super` as the class name and would replace every `this` of the class.
  if (text === "this" || text === "super") throw new Error(CANNOT_RENAME);
  const name = prepared.placeholder ?? text;
  const line = range.startLineNumber;
  const before = model.getValueInRange({ startLineNumber: line, startColumn: Math.max(range.startColumn - 1, 1), endLineNumber: line, endColumn: range.startColumn });
  const from = (await declarationToRename(client, model, at, name).catch(() => null)) ?? { uri, position: prepared.range.start };
  // The kind of the renamed declaration: a destructured `const { name }` renames the property it reads.
  const hover = await client.request<Hover | null>("textDocument/hover", { textDocument: { uri: from.uri }, position: from.position }).catch(() => null);
  return { name, kind: hover ? quickInfoKind(hoverSignature(hover)) : "", isStringLiteral: ['"', "'", "`"].includes(before), ...from };
}

/** The range and name of the renameable symbol at `position` of the document `uri`; null when there is none. */
async function prepareRename(client: LspClient, uri: string, position: Position): Promise<{ range: Range; placeholder?: string } | null> {
  const prepared = await client.request<PrepareRenameResult>("textDocument/prepareRename", { textDocument: { uri }, position });
  if (!prepared || "defaultBehavior" in prepared) return null;
  return "range" in prepared ? prepared : { range: prepared };
}

/**
 * Where the server renames the symbol `name` at `position` from: its declaration inside the worktree, so that a rename
 * started at an import or a usage renames the declaration and every import, like WebStorm (asked there, the server
 * renames only the local name and keeps the old one as an alias). Null when the declaration lies outside the worktree
 * or in a package, or carries another name (the position is on an import alias).
 */
async function declarationToRename(client: LspClient, model: monaco.editor.ITextModel, position: Position, name: string): Promise<{ uri: string; position: Position } | null> {
  const links = asLocationLinks(await client.request<LocationLink[] | Location[] | null>("textDocument/definition", documentPosition(model, position)));
  for (const link of links) {
    const uri = monaco.Uri.parse(link.targetUri);
    if (!isInside(uri, client) || isPackagePath(uri.path)) continue;
    const declared = await prepareRename(client, link.targetUri, link.targetSelectionRange.start).catch(() => null);
    if (declared?.placeholder !== name) continue;
    return { uri: link.targetUri, position: link.targetSelectionRange.start };
  }
  return null;
}

/**
 * Everything renaming `target` to `newName` changes: the language server's edits across the project (whose projects
 * are loaded first, see `loadProjectsMentioning`; `model` names the server), in Angular projects the Angular language
 * server's edits in component templates and, as `options` ask, the whole-word matches of the old name in comments and
 * strings of source files and in every other file of the worktree. Rejects when the server would edit a file outside
 * the worktree or in a package.
 */
export async function planRename(workspace: Workspace, model: monaco.editor.ITextModel, target: RenameTarget, newName: string, options: RenameOptions): Promise<RenamePlan> {
  const client = lspClientForModel(model);
  if (!client) throw new Error("Rename needs the TypeScript language server, which does not serve this file.");
  const word = target.name.replace(/^#/, "");
  await loadProjectsMentioning(client, word).catch(() => {});
  const params = { textDocument: { uri: target.uri }, position: target.position, newName };
  const [edit, angularEdit] = await Promise.all([
    client.request<WorkspaceEdit | null>("textDocument/rename", params).catch((reason) => {
      throw new Error(serverErrorMessage(reason));
    }),
    client.request<WorkspaceEdit | null>("textDocument/rename", params, undefined, "angular").catch(() => null),
  ]);

  const texts = new Map<string, string>();
  const occurrences: RenameOccurrence[] = [];
  for (const [uri, edits] of mergeRenameEdits(editsByUri(edit), editsByUri(angularEdit))) {
    const path = workspace.pathOf(monaco.Uri.parse(uri));
    if (!path) throw new Error(`The rename would change ${monaco.Uri.parse(uri).fsPath}, which lies outside the worktree.`);
    if (isPackagePath(path)) throw new Error(`The rename would change ${path}, which belongs to an installed package.`);
    const text = await fileText(workspace, path);
    const lines = text.split(/\r?\n/);
    texts.set(path, text);
    for (const lspEdit of edits) {
      const range = toMonacoRange(lspEdit.range);
      const occurrenceRange = { line: range.startLineNumber, column: range.startColumn, endLine: range.endLineNumber, endColumn: range.endColumn };
      occurrences.push(occurrenceAt("code", path, occurrenceRange, lspEdit.newText, lines[range.startLineNumber - 1] ?? ""));
    }
  }

  if (options.commentsAndStrings || options.textOccurrences) {
    for (const path of await filesMentioning(workspace, word)) {
      const isSource = isSourceFile(path);
      if (isSource ? !options.commentsAndStrings : !options.textOccurrences) continue;
      const text = texts.get(path) ?? (await fileText(workspace, path).catch(() => null));
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      const matches = isSource ? commentAndStringMatches(lines, monaco.editor.tokenize(text, monacoLanguage(path)), target.name) : wordMatches(lines, target.name);
      if (!matches.length) continue;
      texts.set(path, text);
      for (const match of matches) {
        occurrences.push(wordOccurrence(isSource ? "comment" : "text", path, lines, match, target.name, newName));
      }
    }
  }
  return { name: target.name, newName, occurrences: mergeOccurrences(occurrences), texts };
}

/**
 * Applies the occurrences of `plan` whose keys are `included`: each file is loaded into the workspace and edited in one
 * undo step, then the files that had no unsaved edits before are saved, as WebStorm and VS Code do after a refactoring.
 * Rejects without changing anything when a file changed after the plan was made.
 */
export async function applyRename(workspace: Workspace, plan: RenamePlan, included: ReadonlySet<string>): Promise<void> {
  const byPath = new Map<string, RenameOccurrence[]>();
  for (const occurrence of plan.occurrences) {
    if (!included.has(occurrence.key)) continue;
    byPath.set(occurrence.path, [...(byPath.get(occurrence.path) ?? []), occurrence]);
  }
  const files = await Promise.all(
    [...byPath].map(async ([path, occurrences]) => {
      const wasDirty = workspace.isDirty(path);
      return { path, occurrences, wasDirty, model: (await workspace.load(path)).model };
    }),
  );
  const changed = files.find((file) => file.model.getLinesContent().join("\n") !== (plan.texts.get(file.path) ?? "").split(/\r?\n/).join("\n"));
  if (changed) throw new Error(`${changed.path} changed while the rename was prepared. Start the rename again.`);

  for (const file of files) {
    const edits = file.occurrences.map((occurrence) => ({ range: new monaco.Range(occurrence.line, occurrence.column, occurrence.endLine, occurrence.endColumn), text: occurrence.newText }));
    file.model.pushStackElement();
    file.model.pushEditOperations([], edits, () => null);
    file.model.pushStackElement();
  }
  await Promise.all(files.filter((file) => !file.wasDirty).map((file) => workspace.save(file.path)));
}

/** The shared text of `path` when it has unsaved edits or is loaded, otherwise the content on disk. */
async function fileText(workspace: Workspace, path: string): Promise<string> {
  const loaded = workspace.get(path);
  if (loaded) return loaded.model.getValue();
  if (workspace.isDirty(path)) return (await workspace.load(path)).model.getValue();
  return commands.readFile(workspace.sessionId, path);
}

/** Worktree files containing `word` as a whole word on disk, plus the files with unsaved edits, which may contain it only there. */
async function filesMentioning(workspace: Workspace, word: string): Promise<string[]> {
  const onDisk = await commands.searchWord(workspace.sessionId, word).catch(() => [] as string[]);
  return [...new Set([...onDisk, ...workspace.dirtyPaths()])].sort();
}
