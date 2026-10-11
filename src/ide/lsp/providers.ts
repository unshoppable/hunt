import * as monaco from "monaco-editor";
import { lspClientForModel, onPushedDiagnostics, type LspClient } from "./client";
import { hoverMarkdown, resolvedFields, toLspPosition, toLspRange, toMonacoCompletion, toMonacoPosition, toMonacoRange, toMonacoSignatureHelp, type CompletionItem, type CompletionList, type Diagnostic, type DocumentDiagnosticReport, type DocumentHighlight, type Hover, type InlayHint, type SignatureHelp } from "./protocol";

const LANGUAGES = ["typescript", "javascript"];
const MARKER_OWNER = "lsp";
/** Characters after which the server is asked for completions on its own: member access, string and path starts, decorators, JSX, private names, `import ` keyword lists, JSDoc tags. */
const COMPLETION_TRIGGERS = [".", '"', "'", "`", "/", "@", "<", "#", " ", "*"];
const SIGNATURE_TRIGGERS = ["(", ",", "<"];
const SIGNATURE_RETRIGGERS = [")"];
/** Pause after the last edit before the diagnostics of a document are pulled again. */
const DIAGNOSTICS_DELAY_MS = 300;

let isRegistered = false;

/** A suggestion as the widget holds it: the server's item and its client travel along for `completionItem/resolve`. */
type LspCompletion = monaco.languages.CompletionItem & { lsp: CompletionItem; client: LspClient };
/** Signature help as shown, with the server's version for the retrigger context. */
type LspSignatureHelp = monaco.languages.SignatureHelp & { lsp: SignatureHelp };

/**
 * Registers the editor features served by the language server for TypeScript and JavaScript models of a worktree:
 * completion (with auto-import and documentation on resolve), signature help, hover, inlay hints, occurrence
 * highlights and diagnostics (pulled after edits, pushed ones applied as they come).
 * Models the server does not know (diff models, previews) get nothing from these providers; runs once.
 */
export function registerLspProviders(): void {
  if (isRegistered) return;
  isRegistered = true;

  monaco.languages.registerCompletionItemProvider(LANGUAGES, {
    triggerCharacters: COMPLETION_TRIGGERS,
    provideCompletionItems: (model, position, context, token) =>
      withClient(model, async (client) => {
        const params = { ...documentPosition(model, position), context: { triggerKind: toLspCompletionTrigger(context.triggerKind), triggerCharacter: context.triggerCharacter } };
        const result = await client.request<CompletionList | CompletionItem[] | null>("textDocument/completion", params, token);
        if (!result) return null;
        const list: CompletionList = Array.isArray(result) ? { isIncomplete: false, items: result } : result;
        const word = model.getWordUntilPosition(position);
        const wordRange = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
        const suggestions: LspCompletion[] = list.items.map((item) => ({ ...toMonacoCompletion(item, list.itemDefaults, wordRange), client }));
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
        if (!hover) return null;
        const value = hoverMarkdown(hover);
        if (!value.trim()) return null;
        return { contents: [{ value }], range: hover.range ? toMonacoRange(hover.range) : undefined };
      }),
  });

  monaco.languages.registerInlayHintsProvider(LANGUAGES, {
    provideInlayHints: (model, range, token) =>
      withClient(model, async (client) => {
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
 * Asks the server for the documentation, detail and additional edits (auto-imports) of a completion item when
 * the suggest widget focuses it. Items that did not come from the server, and failed resolves, stay as they are.
 */
async function resolveCompletion(item: LspCompletion, token: monaco.CancellationToken): Promise<LspCompletion> {
  if (!item.lsp || !item.client) return item;
  try {
    const resolved = await item.client.request<CompletionItem | null>("completionItem/resolve", item.lsp, token);
    if (!resolved) return item;
    return { ...item, ...resolvedFields(resolved), lsp: resolved };
  } catch {
    return item;
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
