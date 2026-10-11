import * as monaco from "monaco-editor";
import { commands } from "../../ipc/commands";
import { listenTo } from "../../ipc/events";
import type { Diagnostic, DocumentSymbol } from "./protocol";
import { toContentChanges } from "./protocol";

/** Language ids whose models the language server receives. */
const SERVED_LANGUAGES = new Set(["typescript", "javascript"]);

const clients = new Map<string, LspClient>();
let eventsSubscribed = false;

/** Listeners for diagnostics the server pushes; the providers turn them into editor markers. */
const diagnosticsListeners = new Set<(model: monaco.editor.ITextModel, diagnostics: Diagnostic[]) => void>();

/**
 * The TypeScript language server (`tsgo --lsp`) of one worktree, run by the backend and shared by every session
 * of the worktree. The client keeps the server's view of the open documents in sync with the Monaco models
 * (full text on open, incremental edits afterwards), forwards requests and re-opens every document after the
 * server process was replaced.
 */
export class LspClient {
  /** Documents the server should know, by URI. */
  private readonly tracked = new Map<string, monaco.editor.ITextModel>();
  /** Documents the current server process has received `didOpen` for. */
  private readonly synced = new Set<string>();
  /** Notifications in flight; a request waits for them so the server sees the edits it refers to. */
  private queue: Promise<void> = Promise.resolve();
  private nextToken = 1;
  private reportedMissing = false;
  /** Document symbols per URI, valid for the model version they were computed for. */
  private readonly symbols = new Map<string, { version: number; result: Promise<DocumentSymbol[]> }>();

  constructor(
    /** Session the backend resolves the worktree from; sub chats of the worktree may pass their own id. */
    public sessionId: string,
    readonly worktreePath: string,
  ) {}

  /** Whether `model` is a worktree document of a language the server handles. */
  serves(model: monaco.editor.ITextModel): boolean {
    return this.tracked.has(model.uri.toString());
  }

  /**
   * Registers a worktree model with the server: it is opened now and every edit is forwarded until the model is
   * disposed. Models of other languages are ignored.
   */
  track(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    if (!SERVED_LANGUAGES.has(model.getLanguageId()) || this.tracked.has(uri)) return;
    this.tracked.set(uri, model);
    this.enqueue(() => this.open(model));
    const subscriptions = [
      model.onDidChangeContent((event) => {
        if (!this.synced.has(uri)) return;
        const params = { textDocument: { uri, version: model.getVersionId() }, contentChanges: toContentChanges(event) };
        this.enqueue(() => commands.lspNotify(this.sessionId, "textDocument/didChange", params));
      }),
      model.onWillDispose(() => {
        this.tracked.delete(uri);
        this.symbols.delete(uri);
        for (const subscription of subscriptions) {
          subscription.dispose();
        }
        if (!this.synced.has(uri)) return;
        this.synced.delete(uri);
        this.enqueue(() => commands.lspNotify(this.sessionId, "textDocument/didClose", { textDocument: { uri } }));
      }),
    ];
  }

  /**
   * Sends `method` and resolves with the server's result. Requests are sent after the queued document updates;
   * a cancelled `token` cancels the request on the server, and the promise rejects.
   */
  async request<Result>(method: string, params: unknown, token?: monaco.CancellationToken): Promise<Result> {
    await this.queue;
    if (token?.isCancellationRequested) throw new Error("cancelled");
    const name = `${this.nextToken++}`;
    const subscription = token?.onCancellationRequested(() => void commands.lspCancel(this.sessionId, name).catch(() => {}));
    try {
      return (await commands.lspRequest(this.sessionId, method, params, name)) as Result;
    } catch (error) {
      this.reportOnce(error);
      throw error;
    } finally {
      subscription?.dispose();
    }
  }

  /** The document symbol tree of `model`, shared between callers asking for the same model version. */
  documentSymbols(model: monaco.editor.ITextModel): Promise<DocumentSymbol[]> {
    const uri = model.uri.toString();
    const version = model.getVersionId();
    const cached = this.symbols.get(uri);
    if (cached && cached.version === version) return cached.result;
    const result = this.request<DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri } })
      .then((symbols) => symbols ?? [])
      .catch((error) => {
        this.symbols.delete(uri);
        throw error;
      });
    this.symbols.set(uri, { version, result });
    return result;
  }

  /** Forgets the sync state after the server process ended; every tracked document is reopened before the next request. */
  handleExit(): void {
    this.synced.clear();
    this.symbols.clear();
    for (const model of this.tracked.values()) {
      this.enqueue(() => this.open(model));
    }
  }

  /** A missing server binary is reported once per worktree; every feature stays quiet otherwise. */
  private reportOnce(error: unknown): void {
    if (this.reportedMissing || !String(error).includes("tsgo not found")) return;
    this.reportedMissing = true;
    console.warn(`language features are off for ${this.worktreePath}: ${String(error)}`);
  }

  private open(model: monaco.editor.ITextModel): Promise<void> {
    const uri = model.uri.toString();
    if (model.isDisposed() || !this.tracked.has(uri) || this.synced.has(uri)) return Promise.resolve();
    this.synced.add(uri);
    const textDocument = { uri, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() };
    return commands.lspNotify(this.sessionId, "textDocument/didOpen", { textDocument });
  }

  /** Notifications go out one after another; a failed one (server missing) does not block the next. */
  private enqueue(send: () => Promise<void>): void {
    this.queue = this.queue.then(send).catch((error) => console.warn("language server notification failed:", error));
  }
}

/** The client of a worktree; created on first use. Sessions sharing a worktree (sub chats) share the server. */
export function lspClientFor(sessionId: string, worktreePath: string): LspClient {
  subscribeToServerEvents();
  let client = clients.get(worktreePath);
  if (!client) {
    client = new LspClient(sessionId, worktreePath);
    clients.set(worktreePath, client);
  }
  client.sessionId = sessionId;
  return client;
}

/** The client serving `model`, or null for models the language server does not know (diffs, previews, other languages). */
export function lspClientForModel(model: monaco.editor.ITextModel): LspClient | null {
  for (const client of clients.values()) {
    if (client.serves(model)) return client;
  }
  return null;
}

/** Subscribes to diagnostics the server pushes for a tracked model. */
export function onPushedDiagnostics(listener: (model: monaco.editor.ITextModel, diagnostics: Diagnostic[]) => void): monaco.IDisposable {
  diagnosticsListeners.add(listener);
  return { dispose: () => diagnosticsListeners.delete(listener) };
}

function subscribeToServerEvents(): void {
  if (eventsSubscribed) return;
  eventsSubscribed = true;
  void listenTo("lsp:exited", ({ worktreePath }) => clients.get(worktreePath)?.handleExit());
  void listenTo("lsp:diagnostics", ({ worktreePath, uri, diagnostics }) => {
    if (!clients.has(worktreePath)) return;
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model || !lspClientForModel(model)) return;
    for (const listener of diagnosticsListeners) {
      listener(model, (diagnostics as Diagnostic[] | null) ?? []);
    }
  });
}
