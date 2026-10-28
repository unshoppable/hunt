import * as monaco from "monaco-editor";
import { typeScriptWorkerFor } from "../../editor/semantic-tokens.monaco";
import { lspClientForModel, lspClientForTemplate, onPushedDiagnostics, type LspClient } from "./lsp-client.service";
import { isMemberList, likelyVisibleOrder } from "./completion-items.utils";
import { hoverMarkdown, resolvedFields, toLspPosition, toLspRange, toMonacoCompletion, toMonacoPosition, toMonacoRange, toMonacoSignatureHelp, type CompletionItem, type CompletionList, type Diagnostic, type DocumentDiagnosticReport, type DocumentHighlight, type Hover, type InlayHint, type SignatureHelp } from "./lsp-protocol.utils";

const LANGUAGES = ["typescript", "javascript"];
/** Owner of the markers made from the language server's diagnostics. */
export const MARKER_OWNER = "lsp";
/** The server's completion trigger characters: member access, string and path starts, decorators, JSX, private names, `import ` keyword lists, JSDoc tags. */
const SERVER_TRIGGERS = [".", '"', "'", "`", "/", "@", "<", "#", " ", "*"];
/** Characters after which an object member starts; the list opens there only when the syntax says so (see `completionRequest`). */
const MEMBER_TRIGGERS = ["{", ","];
/** A line ending in a member separator and whitespace, where a typed space may also open the member list. */
const AFTER_MEMBER_SEPARATOR = /[{,]\s*$/;
/** Rows the suggest widget shows at once; their types are resolved before the list opens. */
const VISIBLE_ROWS = 12;
/** Longest wait for those types; a row resolved later gets its type when it is drawn again. */
const VISIBLE_ROWS_BUDGET_MS = 80;
/** Rows of a member list whose types are resolved in the background after it opened. */
const MEMBER_ROWS_LIMIT = 150;
const SIGNATURE_TRIGGERS = ["(", ",", "<"];
const SIGNATURE_RETRIGGERS = [")"];
/** Pause after the last edit before the diagnostics of a document are pulled again. */
const DIAGNOSTICS_DELAY_MS = 300;

let isRegistered = false;

/**
 * A suggestion as the widget holds it: the server's item and its client travel along for `completionItem/resolve`,
 * whose answer is written into the suggestion once (`resolution`).
 */
type LspCompletion = monaco.languages.CompletionItem & { lsp: CompletionItem; client: LspClient; resolution?: Promise<void> };
/** How to ask the server for a list, and how the list opens. */
type CompletionRequest = {
  context: { triggerKind: 1 | 2 | 3; triggerCharacter?: string };
  /** The answer counts only when it is a member list. */
  isMembersOnly: boolean;
  /** The list opens with its first item focused, so Enter accepts it. */
  focusesFirst: boolean;
};
/**
 * Monaco's suggest controller keeps its widget internal. Its list draws a row only when the row scrolls in or its item
 * is spliced in again; the widget ignores the focus events of such a splice while `_ignoreFocusEvents` is set.
 */
type SuggestControllerInternals = {
  widget?: {
    value?: {
      _ignoreFocusEvents: boolean;
      _list?: { length: number; element(index: number): unknown; getFocus(): number[]; setFocus(indexes: number[]): void; splice(start: number, deleteCount: number, elements: unknown[]): void };
    };
  };
};
/** Signature help as shown, with the server's version for the retrigger context. */
type LspSignatureHelp = monaco.languages.SignatureHelp & { lsp: SignatureHelp };

/**
 * Registers the editor features served by the language server for TypeScript and JavaScript models of a worktree:
 * completion (with each row's type, documentation and auto-import on resolve; opening on its own at object members),
 * signature help, hover, inlay hints, occurrence highlights and diagnostics (pulled after edits, pushed ones applied as
 * they come). tsgo has no `semanticTokens`; coloring stays with the TypeScript worker (`editor/semantic-tokens.monaco.ts`).
 * In Angular projects the Angular language server adds the hover in templates and inline templates.
 * Models the server does not know (diff models, previews) get nothing from these providers; runs once.
 */
export function registerLspProviders(): void {
  if (isRegistered) return;
  isRegistered = true;

  monaco.languages.registerCompletionItemProvider(LANGUAGES, {
    triggerCharacters: [...SERVER_TRIGGERS, ...MEMBER_TRIGGERS],
    provideCompletionItems: (model, position, context, token) =>
      withClient(model, async (client) => {
        const request = await completionRequest(model, position, context);
        if (!request || token.isCancellationRequested) return null;
        focusFirstSuggestion(model, request.focusesFirst);
        const params = { ...documentPosition(model, position), context: request.context };
        const result = await client.request<CompletionList | CompletionItem[] | null>("textDocument/completion", params, token);
        if (!result) return null;
        const list: CompletionList = Array.isArray(result) ? { isIncomplete: false, items: result } : result;
        const isMembers = isMemberList(list.items);
        if (request.isMembersOnly && !isMembers) return null;
        const word = model.getWordUntilPosition(position);
        const wordRange = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
        const suggestions: LspCompletion[] = list.items.map((item) => ({ ...toMonacoCompletion(item, list.itemDefaults, wordRange), client }));
        await resolveRowTypes(model, suggestions, word.word, isMembers, token);
        return { incomplete: list.isIncomplete, suggestions };
      }),
    resolveCompletionItem: (item, token) => resolveCompletion(item as LspCompletion, token),
  });

  monaco.languages.registerSignatureHelpProvider(LANGUAGES, {
    signatureHelpTriggerCharacters: SIGNATURE_TRIGGERS,
    signatureHelpRetriggerCharacters: SIGNATURE_RETRIGGERS,
    provideSignatureHelp: (model, position, token, context) =>
      withClient(model, async (client) => {
        const active = context.activeSignatureHelp as LspSignatureHelp | undefined;
        const params = {
          ...documentPosition(model, position),
          context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger, activeSignatureHelp: active?.lsp },
        };
        const help = await client.request<SignatureHelp | null>("textDocument/signatureHelp", params, token);
        if (!help || help.signatures.length === 0) return null;
        const value: LspSignatureHelp = { ...toMonacoSignatureHelp(help), lsp: help };
        return { value, dispose: () => {} };
      }),
  });

  monaco.languages.registerHoverProvider(LANGUAGES, {
    provideHover: (model, position, token) =>
      withClient(model, async (client) => {
        const hover = await client.request<Hover | null>("textDocument/hover", documentPosition(model, position), token);
        const value = hover ? hoverMarkdown(hover) : "";
        // tsgo knows nothing inside a component's inline template; the Angular server does.
        if (!hover || !value.trim()) return angularHover(client, model, position, token);
        return { contents: [{ value }], range: hover.range ? toMonacoRange(hover.range) : undefined };
      }),
  });

  monaco.languages.registerHoverProvider("html", {
    provideHover: (model, position, token) => {
      const client = lspClientForTemplate(model);
      return client ? angularHover(client, model, position, token) : null;
    },
  });

  monaco.languages.registerInlayHintsProvider(LANGUAGES, {
    provideInlayHints: (model, range, token) =>
      withClient(model, async (client) => {
        // Monaco clamps `range` to the model; tsgo panics on a range past the last line.
        const params = { textDocument: { uri: model.uri.toString() }, range: toLspRange(range) };
        const hints = await client.request<InlayHint[] | null>("textDocument/inlayHint", params, token);
        return { hints: (hints ?? []).map(toMonacoInlayHint), dispose: () => {} };
      }),
  });

  monaco.languages.registerDocumentHighlightProvider(LANGUAGES, {
    provideDocumentHighlights: (model, position, token) =>
      withClient(model, async (client) => {
        const highlights = await client.request<DocumentHighlight[] | null>("textDocument/documentHighlight", documentPosition(model, position), token);
        return (highlights ?? []).map((highlight) => ({ range: toMonacoRange(highlight.range), kind: toMonacoHighlightKind(highlight.kind) }));
      }),
  });

  watchDiagnostics();
}

/** Runs `provide` for models the language server serves; failures (server missing, cancelled) yield nothing. */
async function withClient<Result>(model: monaco.editor.ITextModel, provide: (client: LspClient) => Promise<Result | null>): Promise<Result | null> {
  const client = lspClientForModel(model);
  if (!client) return null;
  try {
    return await provide(client);
  } catch {
    return null;
  }
}

function documentPosition(model: monaco.editor.ITextModel, position: monaco.IPosition) {
  return { textDocument: { uri: model.uri.toString() }, position: toLspPosition(position) };
}

/**
 * The Angular language server's hover at `position` of a template or inline template: the component or directive of a
 * tag, the type of an input, an expression's name or a pipe. Null when the worktree has no Angular server. The hover
 * covers the hovered word: at a tag the server's range spans the whole element.
 */
async function angularHover(client: LspClient, model: monaco.editor.ITextModel, position: monaco.Position, token: monaco.CancellationToken): Promise<monaco.languages.Hover | null> {
  const hover = await client.request<Hover | null>("textDocument/hover", documentPosition(model, position), token, "angular").catch(() => null);
  const value = hover ? hoverMarkdown(hover) : "";
  if (!value.trim()) return null;
  const word = model.getWordAtPosition(position);
  const range = word ? { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn } : undefined;
  return { contents: [{ value }], range };
}

/** LSP `CompletionTriggerKind` (1 invoked, 2 trigger character, 3 incomplete list) for Monaco's 0-based kinds. */
function toLspCompletionTrigger(kind: monaco.languages.CompletionTriggerKind): 1 | 2 | 3 {
  switch (kind) {
    case monaco.languages.CompletionTriggerKind.TriggerCharacter:
      return 2;
    case monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions:
      return 3;
    default:
      return 1;
  }
}

/**
 * How to ask the server for the list Monaco wants at `position`, or null when there is nothing to ask for. `{` and `,`
 * (and a space after them) open the list only where an object member starts, which the TypeScript worker tells from
 * the syntax without a round trip to the server. tsgo does not know these characters (it answers `{` and `,` with
 * -32603 and a space with nothing), so the request is a plain invocation (triggerKind 1), and only a member list
 * counts. A list that opens on its own after anything but `.` has no item focused, so Enter still breaks the line
 * until ↓ or a typed letter picks one.
 */
async function completionRequest(model: monaco.editor.ITextModel, position: monaco.Position, context: monaco.languages.CompletionContext): Promise<CompletionRequest | null> {
  const character = context.triggerCharacter;
  if (context.triggerKind !== monaco.languages.CompletionTriggerKind.TriggerCharacter || !character) {
    return { context: { triggerKind: toLspCompletionTrigger(context.triggerKind) }, isMembersOnly: false, focusesFirst: true };
  }
  const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  const followsSeparator = MEMBER_TRIGGERS.includes(character) || (character === " " && AFTER_MEMBER_SEPARATOR.test(linePrefix));
  if (followsSeparator && (await startsObjectMember(model, position))) {
    return { context: { triggerKind: 1 }, isMembersOnly: true, focusesFirst: false };
  }
  if (!SERVER_TRIGGERS.includes(character)) return null;
  return { context: { triggerKind: 2, triggerCharacter: character }, isMembersOnly: false, focusesFirst: character === "." };
}

/** Whether a member of an object literal or destructuring pattern starts at `position`; false while the worker is unavailable. */
async function startsObjectMember(model: monaco.editor.ITextModel, position: monaco.Position): Promise<boolean> {
  try {
    const worker = await typeScriptWorkerFor(model);
    return !!worker && (await worker.isObjectMemberPosition(model.uri.toString(), model.getOffsetAt(position)));
  } catch {
    return false;
  }
}

/**
 * Monaco decides per editor, not per request, whether a list opens with its first item focused; the editor typing into
 * `model` gets the mode for the list about to open. `whenQuickSuggestion` leaves only lists opened by a trigger
 * character unfocused, and focuses them too once a letter is typed.
 */
function focusFirstSuggestion(model: monaco.editor.ITextModel, focusesFirst: boolean): void {
  const selectionMode = focusesFirst ? "always" : "whenQuickSuggestion";
  for (const editor of monaco.editor.getEditors()) {
    if (editor.getModel() !== model || !editor.hasTextFocus()) continue;
    if (editor.getOption(monaco.editor.EditorOption.suggest).selectionMode === selectionMode) continue;
    editor.updateOptions({ suggest: { selectionMode } });
  }
}

/**
 * Resolves the types of the rows the widget shows first (waiting at most `VISIBLE_ROWS_BUDGET_MS`), then those of the
 * rest of a member list in the background, and redraws the open list once they are in. The server answers resolves one
 * after another, about 2 ms each after the first, so a global list with thousands of rows only gets its first ones.
 */
async function resolveRowTypes(model: monaco.editor.ITextModel, suggestions: LspCompletion[], word: string, isMembers: boolean, token: monaco.CancellationToken): Promise<void> {
  const order = likelyVisibleOrder(suggestions.map((suggestion) => suggestion.lsp), word);
  const visible = Promise.all(order.slice(0, VISIBLE_ROWS).map((index) => resolveInto(suggestions[index], token)));
  const rest = isMembers ? order.slice(VISIBLE_ROWS, MEMBER_ROWS_LIMIT) : [];
  void Promise.all([visible, ...rest.map((index) => resolveInto(suggestions[index], token))]).then(() => redrawSuggestions(model));
  await Promise.race([visible, new Promise((resolve) => setTimeout(resolve, VISIBLE_ROWS_BUDGET_MS))]);
}

/**
 * Asks the server once for the type, documentation and auto-import edits of `item` and writes them into it; a cancelled
 * or failed request is asked again next time. Items that did not come from the server stay as they are.
 */
function resolveInto(item: LspCompletion, token: monaco.CancellationToken): Promise<void> {
  // tsgo looks the item up by its `data` and panics without it, which ends the server process.
  if (!item.lsp?.data || !item.client) return Promise.resolve();
  item.resolution ??= item.client.request<CompletionItem | null>("completionItem/resolve", item.lsp, token).then(
    (resolved) => {
      if (resolved) {
        Object.assign(item, resolvedFields(resolved));
      }
    },
    () => {
      item.resolution = undefined;
    },
  );
  return item.resolution;
}

/** Resolves `item` when the suggest widget focuses it; usually its rows' types were resolved already. */
async function resolveCompletion(item: LspCompletion, token: monaco.CancellationToken): Promise<LspCompletion> {
  await resolveInto(item, token);
  return item;
}

/**
 * Redraws the open list of the editor typing into `model`, so types resolved after the list opened show in its rows:
 * the shown items are spliced in again and the focus restored, as Monaco does after resolving the focused item.
 */
function redrawSuggestions(model: monaco.editor.ITextModel): void {
  for (const editor of monaco.editor.getEditors()) {
    if (editor.getModel() !== model || !editor.hasTextFocus()) continue;
    const controller = editor.getContribution("editor.contrib.suggestController") as SuggestControllerInternals | null;
    const widget = controller?.widget?.value;
    const list = widget?._list;
    if (!widget || !list?.length) continue;
    const items = Array.from({ length: list.length }, (_, index) => list.element(index));
    const focus = list.getFocus();
    widget._ignoreFocusEvents = true;
    try {
      list.splice(0, list.length, items);
      list.setFocus(focus);
    } finally {
      widget._ignoreFocusEvents = false;
    }
  }
}

function toMonacoInlayHint(hint: InlayHint): monaco.languages.InlayHint {
  const label = typeof hint.label === "string" ? hint.label : hint.label.map((part) => ({ label: part.value }));
  return {
    label,
    position: toMonacoPosition(hint.position),
    kind: hint.kind === 1 ? monaco.languages.InlayHintKind.Type : hint.kind === 2 ? monaco.languages.InlayHintKind.Parameter : undefined,
    paddingLeft: hint.paddingLeft,
    paddingRight: hint.paddingRight,
  };
}

function toMonacoHighlightKind(kind: DocumentHighlight["kind"]): monaco.languages.DocumentHighlightKind {
  switch (kind) {
    case 2:
      return monaco.languages.DocumentHighlightKind.Read;
    case 3:
      return monaco.languages.DocumentHighlightKind.Write;
    default:
      return monaco.languages.DocumentHighlightKind.Text;
  }
}

function toMonacoSeverity(severity: Diagnostic["severity"]): monaco.MarkerSeverity {
  switch (severity) {
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}

function applyDiagnostics(model: monaco.editor.ITextModel, diagnostics: Diagnostic[]): void {
  if (model.isDisposed()) return;
  const markers = diagnostics.map((diagnostic) => ({
    ...toMonacoRange(diagnostic.range),
    message: diagnostic.message,
    severity: toMonacoSeverity(diagnostic.severity),
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
    source: diagnostic.source,
    tags: diagnostic.tags?.flatMap((tag) => (tag === 1 ? [monaco.MarkerTag.Unnecessary] : tag === 2 ? [monaco.MarkerTag.Deprecated] : [])),
  }));
  monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
}

/**
 * Pulls the diagnostics of every served model once it exists and after each pause in editing, and applies the
 * ones the server pushes on its own (reported for files whose dependencies changed).
 */
function watchDiagnostics(): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const pull = (model: monaco.editor.ITextModel) => {
    const version = model.getVersionId();
    void withClient(model, async (client) => {
      const report = await client.request<DocumentDiagnosticReport | null>("textDocument/diagnostic", { textDocument: { uri: model.uri.toString() } });
      if (!report || report.kind !== "full" || model.getVersionId() !== version) return null;
      applyDiagnostics(model, report.items);
      return null;
    });
  };

  const schedule = (model: monaco.editor.ITextModel) => {
    const key = model.uri.toString();
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        pull(model);
      }, DIAGNOSTICS_DELAY_MS),
    );
  };

  const watch = (model: monaco.editor.ITextModel) => {
    if (!LANGUAGES.includes(model.getLanguageId()) || model.uri.scheme !== "file") return;
    // The workspace registers the model with its client right after creating it; the first pull follows that.
    schedule(model);
    model.onDidChangeContent(() => schedule(model));
  };

  for (const model of monaco.editor.getModels()) {
    watch(model);
  }
  monaco.editor.onDidCreateModel(watch);
  onPushedDiagnostics(applyDiagnostics);
}
