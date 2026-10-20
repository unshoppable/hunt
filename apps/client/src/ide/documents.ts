import * as monaco from "monaco-editor";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import type { DocumentChangedEvent, DocumentContentChange, DocumentState } from "../ipc/types";
import { monacoLanguage } from "../diff/monaco";
import { refreshSemanticTokens, typeScriptWorkerFor } from "../diff/semanticTokens";
import { parseImportSpecifiers } from "./imports";
import { lspClientFor, type LspClient } from "./lsp/client";
import { toLspRange, toMonacoRange } from "./lsp/protocol";
import { minimalChange, remoteChangeAction } from "./sharedDocument";
import { confirmDestructive } from "../ui/confirm";
import { baseName } from "../ui/path";

/** A worktree file loaded into a Monaco model; the model is shared by every editor of this window showing the file. */
export type Document = {
  /** Worktree-relative path. */
  path: string;
  model: monaco.editor.ITextModel;
};

/** How the model of this window follows the backend's shared document of the same file. */
type Replica = {
  /** The shared version the model holds. */
  version: number;
  isDirty: boolean;
  /** Own edits queued or sent but not answered yet. */
  pendingEdits: number;
  isResyncing: boolean;
  /** Newest version a change event reported; checked again once the replica is idle. */
  seenVersion: number;
  /** Grows with every re-read; a queued edit of an older generation was made on replaced text and is dropped. */
  generation: number;
  /** Set while the model takes over a change made elsewhere, which must not be sent back. */
  isApplying: boolean;
};

type DirtyListener = (path: string, isDirty: boolean) => void;

/**
 * The documents of one worktree in this window. Each is a replica of the one text the backend holds for the file
 * (src-tauri/src/documents.rs), like the editors of an IDE sharing one document: edits made here go to the backend,
 * which forwards them to the language server and to the other windows, and changes made elsewhere arrive as
 * `document:changed`. So every window shows the same text and the same unsaved state. Models live under
 * `file://<worktree>/<path>`, the URIs the language server knows them by. Opening a file also loads the files it
 * imports (one level) and shows them to the coloring worker, so identifiers from those files get their semantic colors.
 */
export class Workspace {
  /** The worktree's language server client; sessions sharing the worktree share it. */
  readonly lsp: LspClient;
  private readonly documents = new Map<string, Document>();
  private readonly replicas = new Map<string, Replica>();
  private readonly loading = new Map<string, Promise<Document>>();
  private readonly dirtyListeners = new Set<DirtyListener>();
  /** Last reported dirty state per path, so listeners only hear changes. */
  private readonly reportedDirty = new Map<string, boolean>();
  /** Paths whose imports were resolved already; a document's imports are loaded once per content. */
  private readonly dependenciesLoadedFor = new Map<string, number>();
  /** HEAD content per path for the editor's change markers; dropped whenever the worktree changes. */
  private readonly headTexts = new Map<string, Promise<string | null>>();
  private readonly headListeners = new Set<() => void>();
  /** Paths shown in tabs, per IDE panel. */
  private readonly tabPaths = new Map<string, string[]>();
  /** The shown paths last reported to the backend, joined by newlines. */
  private reportedViews = "";

  constructor(
    /** Session used for the IPC calls; sub chats share the worktree and may pass their own id. */
    public sessionId: string,
    readonly worktreePath: string,
  ) {
    this.lsp = lspClientFor(sessionId, worktreePath);
    subscribeToDocumentEvents();
  }

  uriOf(path: string): monaco.Uri {
    return monaco.Uri.file(`${this.worktreePath}/${path}`);
  }

  /** Worktree-relative path of a model URI inside this worktree, or null for anything else (`lib.d.ts`, diff models). */
  pathOf(uri: monaco.Uri): string | null {
    if (uri.scheme !== "file") return null;
    const prefix = `${this.worktreePath}/`;
    return uri.path.startsWith(prefix) ? uri.path.slice(prefix.length) : null;
  }

  get(path: string): Document | undefined {
    return this.documents.get(path);
  }

  /** Whether the shared document has edits that are not on disk, made in this window or another one. */
  isDirty(path: string): boolean {
    return !!this.replicas.get(path)?.isDirty;
  }

  onDirtyChange(listener: DirtyListener): monaco.IDisposable {
    this.dirtyListeners.add(listener);
    return { dispose: () => this.dirtyListeners.delete(listener) };
  }

  /** Content of `path` at HEAD, or null when the file is not committed there (or cannot be read). Cached per worktree state. */
  headText(path: string): Promise<string | null> {
    let pending = this.headTexts.get(path);
    if (!pending) {
      pending = commands
        .readFileDiff(this.sessionId, path)
        .then((diff) => diff.oldContent)
        .catch(() => null);
      this.headTexts.set(path, pending);
    }
    return pending;
  }

  /** Fires when the cached HEAD contents were dropped (after a commit, revert or any other worktree change). */
  onHeadChange(listener: () => void): monaco.IDisposable {
    this.headListeners.add(listener);
    return { dispose: () => this.headListeners.delete(listener) };
  }

  /**
   * Loads the file (once; concurrent calls share the request) and resolves with the document as soon as its content
   * is in; the imports load in the background and only refine the semantic colors.
   */
  async open(path: string): Promise<Document> {
    const document = await this.load(path);
    void this.loadDependencies(document);
    return document;
  }

  /**
   * Loads the file like `open` but without its imports, for callers that need only the document and its diagnostics.
   * The text is the shared one, with the unsaved edits of other windows.
   */
  load(path: string): Promise<Document> {
    const existing = this.documents.get(path);
    if (existing) return Promise.resolve(existing);
    const pending = this.loading.get(path);
    if (pending) return pending;

    const request = commands
      .documentOpen(this.sessionId, path, monacoLanguage(path))
      .then((state) => this.documents.get(path) ?? this.adopt(path, state))
      .finally(() => this.loading.delete(path));
    this.loading.set(path, request);
    return request;
  }

  /**
   * The document of `path` at once, for a view that has just read the file itself (a diff's editable side): a document
   * not loaded yet starts from `text` and takes the shared state over a moment later, a loaded one without unsaved
   * edits takes the content on disk over, and unsaved edits stay.
   */
  documentFor(path: string, text: string): Document {
    const document = this.documents.get(path);
    if (document) {
      if (!this.isDirty(path) && document.model.getValue() !== text) {
        void this.reload([path]);
      }
      return document;
    }
    const created = this.adopt(path, { text, version: 0, isDirty: false });
    this.resync(created);
    return created;
  }

  /** Records that the file on disk holds `text` now, e.g. after a diff wrote it. */
  markSaved(path: string, text: string): void {
    if (!this.documents.has(path)) return;
    void this.lsp
      .enqueue(() => commands.documentMarkSaved(this.sessionId, path, text))
      .then((isDirty) => this.applyDirty(path, isDirty))
      .catch((error) => console.warn(`failed to mark ${path} as saved:`, error));
  }

  /** Sets the paths the IDE panel `owner` shows in tabs; with the models attached to an editor, they are what this window shows. */
  setTabPaths(owner: string, paths: string[]): void {
    if (paths.length) {
      this.tabPaths.set(owner, paths);
    } else {
      this.tabPaths.delete(owner);
    }
    this.reportViews();
  }

  /** Takes a change made in another window or by the backend over (for the `document:changed` subscription). */
  applyChange(event: DocumentChangedEvent): void {
    const document = this.documents.get(event.path);
    const replica = this.replicas.get(event.path);
    if (!document || !replica || document.model.isDisposed()) return;
    replica.seenVersion = Math.max(replica.seenVersion, event.version);
    const action = remoteChangeAction(replica.version, replica.pendingEdits > 0 || replica.isResyncing, event.version);
    if (action === "ignore") return;
    if (action === "resync") {
      this.resync(document);
      return;
    }
    if (event.changes) {
      this.applyChanges(document, event.changes);
    } else {
      this.applyText(document, event.text ?? "");
    }
    replica.version = event.version;
    this.applyDirty(event.path, event.isDirty);
  }

  /** Takes the dirty state of the shared document over. */
  applyDirty(path: string, isDirty: boolean): void {
    const document = this.documents.get(path);
    const replica = this.replicas.get(path);
    if (!document || !replica) return;
    replica.isDirty = isDirty;
    this.reportDirty(document);
  }

  private adopt(path: string, state: DocumentState): Document {
    const uri = this.uriOf(path);
    const existing = monaco.editor.getModel(uri);
    const model = existing ?? monaco.editor.createModel(state.text, monacoLanguage(path), uri);
    const document: Document = { path, model };
    const replica: Replica = {
      version: state.version,
      isDirty: state.isDirty,
      pendingEdits: 0,
      isResyncing: false,
      seenVersion: state.version,
      generation: 0,
      isApplying: false,
    };
    this.documents.set(path, document);
    this.replicas.set(path, replica);
    if (existing) {
      this.applyText(document, state.text);
    }
    this.lsp.serve(model);
    model.onDidChangeContent((event) => this.sendEdit(document, event));
    model.onDidChangeAttached(() => this.reportViews());
    this.reportDirty(document);
    return document;
  }

  /** Sends an edit made in this window to the shared document; a refused one makes the model read the document again. */
  private sendEdit(document: Document, event: monaco.editor.IModelContentChangedEvent): void {
    const replica = this.replicas.get(document.path);
    if (!replica || replica.isApplying) return;
    const changes: DocumentContentChange[] = event.changes.map((change) => ({ range: toLspRange(change.range), text: change.text }));
    const generation = replica.generation;
    replica.pendingEdits++;
    void this.lsp.enqueue(async () => {
      try {
        if (replica.generation !== generation || document.model.isDisposed()) return;
        const ack = await commands.documentEdit(this.sessionId, document.path, replica.version, changes);
        if (!ack) {
          this.resync(document);
          return;
        }
        replica.version = ack.version;
        this.applyDirty(document.path, ack.isDirty);
      } catch (error) {
        console.warn(`failed to send an edit of ${document.path}:`, error);
        this.resync(document);
      } finally {
        replica.pendingEdits--;
        this.catchUp(document);
      }
    });
  }

  /** Reads the shared state again and takes it over; edits made here meanwhile go with the replaced text. */
  private resync(document: Document): void {
    const replica = this.replicas.get(document.path);
    if (!replica || replica.isResyncing) return;
    replica.isResyncing = true;
    void this.lsp.enqueue(async () => {
      let isRead = false;
      try {
        const state = await commands.documentOpen(this.sessionId, document.path, monacoLanguage(document.path));
        if (document.model.isDisposed()) return;
        replica.generation++;
        this.applyText(document, state.text);
        replica.version = state.version;
        replica.seenVersion = Math.max(replica.seenVersion, state.version);
        this.applyDirty(document.path, state.isDirty);
        isRead = true;
      } catch (error) {
        console.warn(`failed to read ${document.path} again:`, error);
      } finally {
        replica.isResyncing = false;
      }
      if (isRead) {
        this.catchUp(document);
      }
    });
  }

  /** Re-reads a replica that is idle again but heard of a newer version than it holds. */
  private catchUp(document: Document): void {
    const replica = this.replicas.get(document.path);
    if (!replica || replica.pendingEdits > 0 || replica.isResyncing || replica.seenVersion <= replica.version) return;
    this.resync(document);
  }

  private applyChanges(document: Document, changes: DocumentContentChange[]): void {
    const edits = changes.map((change) => ({ range: toMonacoRange(change.range), text: change.text }));
    this.applyRemote(document, () => document.model.pushEditOperations([], edits, () => null));
  }

  /** Turns the model into `text` with the smallest replacement, so carets and scroll positions outside it stay. */
  private applyText(document: Document, text: string): void {
    const model = document.model;
    const change = minimalChange(model.getValue(), text);
    if (!change) return;
    const range = monaco.Range.fromPositions(model.getPositionAt(change.start), model.getPositionAt(change.end));
    this.applyRemote(document, () => model.pushEditOperations([], [{ range, text: change.text }], () => null));
    this.dependenciesLoadedFor.delete(document.path);
  }

  private applyRemote(document: Document, apply: () => void): void {
    const replica = this.replicas.get(document.path);
    if (!replica) return;
    replica.isApplying = true;
    try {
      apply();
    } finally {
      replica.isApplying = false;
    }
  }

  private reportDirty(document: Document) {
    const isDirty = this.isDirty(document.path);
    if (this.reportedDirty.get(document.path) === isDirty) return;
    this.reportedDirty.set(document.path, isDirty);
    for (const listener of this.dirtyListeners) {
      listener(document.path, isDirty);
    }
  }

  /** Tells the backend which paths this window shows: tab paths and documents attached to an editor. */
  private reportViews(): void {
    const shown = new Set([...this.tabPaths.values()].flat());
    for (const document of this.documents.values()) {
      if (!document.model.isDisposed() && document.model.isAttachedToEditor()) {
        shown.add(document.path);
      }
    }
    const paths = [...shown].sort();
    const key = paths.join("\n");
    if (key === this.reportedViews) return;
    this.reportedViews = key;
    void this.lsp.enqueue(() => commands.documentViews(this.sessionId, paths)).catch((error) => console.warn("failed to report the shown documents:", error));
  }

  /**
   * Loads the files `document` imports with relative specifiers and makes them visible to the coloring worker,
   * which only sees models it was asked to sync; the semantic colors are refreshed afterwards. Failures are ignored.
   */
  private async loadDependencies(document: Document): Promise<void> {
    const version = document.model.getVersionId();
    if (this.dependenciesLoadedFor.get(document.path) === version) return;
    this.dependenciesLoadedFor.set(document.path, version);
    const languageId = document.model.getLanguageId();
    if (languageId !== "typescript" && languageId !== "javascript") return;

    const specifiers = parseImportSpecifiers(document.model.getValue()).filter((specifier) => specifier.startsWith("."));
    if (!specifiers.length) return;
    try {
      const resolved = await commands.resolveImports(this.sessionId, document.path, specifiers);
      const paths = [...new Set(resolved.filter((path): path is string => !!path))];
      await Promise.allSettled(paths.filter((path) => !this.documents.has(path)).map((path) => this.load(path)));
      const loaded = paths.filter((path) => this.documents.has(path)).map((path) => this.uriOf(path));
      if (!loaded.length || document.model.isDisposed()) return;
      await typeScriptWorkerFor(document.model, loaded);
      refreshSemanticTokens();
    } catch {
      // Missing dependencies only cost semantic colors of imported names.
    }
  }

  /** Writes the shared text to disk; every window sees the document as saved. */
  async save(path: string): Promise<void> {
    const document = this.documents.get(path);
    if (!document) return;
    const isDirty = await this.lsp.enqueue(() => commands.documentSave(this.sessionId, path));
    this.applyDirty(path, isDirty);
    void this.loadDependencies(document);
  }

  /**
   * Asks before unsaved edits in `paths` are lost (closing their last tab) and reverts them on consent. Edits that
   * another window shows stay without asking. Returns false when the user keeps the edits, in which case nothing
   * should close.
   */
  async discardIfConfirmed(paths: string[]): Promise<boolean> {
    const dirty = paths.filter((path) => this.isDirty(path));
    if (!dirty.length) return true;
    const shownElsewhere = new Set(await commands.documentsShownElsewhere(this.sessionId, dirty).catch(() => []));
    const discarded = dirty.filter((path) => !shownElsewhere.has(path));
    if (!discarded.length) return true;
    const names = discarded.map((path) => `"${baseName(path)}"`).join(", ");
    if (!(await confirmDestructive(`Discard unsaved changes in ${names}?`, "Discard"))) return false;
    for (const path of discarded) {
      this.revert(path);
    }
    return true;
  }

  /** Throws away the unsaved edits of `path` in every window; the document goes back to the content on disk. */
  revert(path: string): void {
    if (!this.documents.has(path)) return;
    void this.lsp.enqueue(() => commands.documentRevert(this.sessionId, path)).catch((error) => console.warn(`failed to revert ${path}:`, error));
  }

  /** Drops the document of a deleted file: its model is disposed and it no longer counts as dirty. */
  forget(path: string): void {
    const document = this.documents.get(path);
    if (!document) return;
    this.documents.delete(path);
    this.replicas.delete(path);
    this.dependenciesLoadedFor.delete(path);
    if (this.reportedDirty.get(path)) {
      for (const listener of this.dirtyListeners) {
        listener(path, false);
      }
    }
    this.reportedDirty.delete(path);
    document.model.dispose();
    void this.lsp.enqueue(() => commands.documentClose(this.sessionId, path)).catch((error) => console.warn(`failed to close ${path}:`, error));
  }

  /**
   * Re-reads the given documents, by default every loaded one, from disk after the worktree changed (agent edits,
   * reverts, unshelving). Loaded documents include imports and usage previews without a tab; the language server
   * reads them from the shared document, not from disk. Documents with unsaved edits keep them; a file that vanished
   * keeps its model until its tabs close.
   */
  async reloadFromDisk(paths: string[] = [...this.documents.keys()]): Promise<void> {
    this.headTexts.clear();
    for (const listener of this.headListeners) {
      listener();
    }
    await this.reload(paths);
  }

  /** Has the backend take the content on disk over; the new text arrives like any change from elsewhere. */
  private async reload(paths: string[]): Promise<void> {
    const loaded = paths.filter((path) => this.documents.has(path));
    if (!loaded.length) return;
    await this.lsp.enqueue(() => commands.documentReload(this.sessionId, loaded)).catch((error) => console.warn("failed to reload documents:", error));
  }
}

const workspaces = new Map<string, Workspace>();
let isSubscribed = false;

/** Routes the backend's document events to the workspace of their worktree. */
function subscribeToDocumentEvents(): void {
  if (isSubscribed) return;
  isSubscribed = true;
  void listenTo("document:changed", (event) => workspaces.get(event.worktreePath)?.applyChange(event));
  void listenTo("document:dirty", ({ worktreePath, path, isDirty }) => workspaces.get(worktreePath)?.applyDirty(path, isDirty));
}

/** The workspace of a worktree; sessions sharing a worktree (sub chats) share the documents. */
export function workspaceFor(sessionId: string, worktreePath: string): Workspace {
  let workspace = workspaces.get(worktreePath);
  if (!workspace) {
    workspace = new Workspace(sessionId, worktreePath);
    workspaces.set(worktreePath, workspace);
  }
  workspace.sessionId = sessionId;
  workspace.lsp.sessionId = sessionId;
  return workspace;
}
