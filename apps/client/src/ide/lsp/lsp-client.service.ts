import * as monaco from "monaco-editor";
import { commands } from "../../ipc/commands";
import { listenTo } from "../../ipc/events";
import type { LanguageServerKind } from "./lsp.types";
import type { Diagnostic, DocumentSymbol } from "./lsp-protocol.utils";

/** Language ids whose models the language server receives. */
const SERVED_LANGUAGES = new Set(["typescript", "javascript"]);

/** Language ids of the Angular templates, which only the Angular language server receives. */
const TEMPLATE_LANGUAGES = new Set(["html"]);

const clients = new Map<string, LspClient>();
let eventsSubscribed = false;

/** Listeners for diagnostics the server pushes; the providers turn them into editor markers. */
const diagnosticsListeners = new Set<(model: monaco.editor.ITextModel, diagnostics: Diagnostic[]) => void>();

/**
 * The TypeScript language server (`tsgo --lsp`) of one worktree, run by the backend and shared by every session and
 * window of the worktree. The documents reach the server through the backend's shared documents (see documents.service.ts);
 * the client forwards requests and knows which models the server serves.
 */
export class LspClient {
  /** Models the server receives, by URI. */
  private readonly served = new Map<string, monaco.editor.ITextModel>();
  /** URIs of the worktree's template models, which the Angular server receives. */
  private readonly templates = new Set<string>();
  /** Document updates of this window in flight; a request waits for them so the server sees the edits it refers to. */
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
    return this.served.has(model.uri.toString());
  }

  /** Whether `model` is a worktree template the Angular server receives. */
  servesTemplate(model: monaco.editor.ITextModel): boolean {
    return this.templates.has(model.uri.toString());
  }

  /** Counts a worktree model as served (or as a template) until it is disposed; models of other languages are ignored. */
  serve(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    if (TEMPLATE_LANGUAGES.has(model.getLanguageId()) && !this.templates.has(uri)) {
      this.templates.add(uri);
      model.onWillDispose(() => this.templates.delete(uri));
      return;
    }
    if (!SERVED_LANGUAGES.has(model.getLanguageId()) || this.served.has(uri)) return;
    this.served.set(uri, model);
    model.onWillDispose(() => {
      this.served.delete(uri);
      this.symbols.delete(uri);
    });
  }

  /**
   * Runs the document update `send` after the ones queued before it and resolves with its result. Requests wait for
   * the queue; a failed update does not hold up the next one.
   */
  enqueue<Result>(send: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(send);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Sends `method` to `server` (the worktree's TypeScript server by default) and resolves with its result. Requests
   * are sent after the queued document updates; a cancelled `token` cancels the request on the server, and the
   * promise rejects.
   */
  async request<Result>(method: string, params: unknown, token?: monaco.CancellationToken, server: LanguageServerKind = "typescript"): Promise<Result> {
    await this.queue;
    if (token?.isCancellationRequested) throw new Error("cancelled");
    const name = `${this.nextToken++}`;
    const subscription = token?.onCancellationRequested(() => void commands.lspCancel(this.sessionId, name, server).catch(() => {}));
    try {
      return (await commands.lspRequest(this.sessionId, method, params, name, server)) as Result;
    } catch (error) {
      this.reportOnce(error);
      throw error;
    } finally {
      subscription?.dispose();
    }
  }

  /**
   * The document symbol tree of `model`, shared between callers asking for the same model version; empty for models
   * the server does not receive, such as templates, since tsgo crashes on a request for a file it cannot parse.
   */
  documentSymbols(model: monaco.editor.ITextModel): Promise<DocumentSymbol[]> {
    if (!this.serves(model)) return Promise.resolve([]);
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

  /** Forgets cached results after the server process ended; the backend opens the documents in the next one. */
  handleExit(): void {
    this.symbols.clear();
  }

  /** A missing server binary is reported once per worktree; every feature stays quiet otherwise. */
  private reportOnce(error: unknown): void {
    if (this.reportedMissing || !String(error).includes("tsgo not found")) return;
    this.reportedMissing = true;
    console.warn(`language features are off for ${this.worktreePath}: ${String(error)}`);
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

/** The client of the worktree `model` is a template of, or null for templates outside a worktree (diffs, previews). */
export function lspClientForTemplate(model: monaco.editor.ITextModel): LspClient | null {
  for (const client of clients.values()) {
    if (client.servesTemplate(model)) return client;
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
