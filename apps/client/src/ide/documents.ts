import * as monaco from "monaco-editor";
import { commands } from "../ipc/commands";
import { monacoLanguage } from "../diff/monaco";
import { refreshSemanticTokens, typeScriptWorkerFor } from "../diff/semanticTokens";
import { parseImportSpecifiers } from "./imports";
import { lspClientFor, type LspClient } from "./lsp/client";
import { confirmDestructive } from "../ui/confirm";
import { baseName } from "../ui/path";

/** A worktree file loaded into a Monaco model; the model is shared by every editor showing the file. */
export type Document = {
  /** Worktree-relative path. */
  path: string;
  model: monaco.editor.ITextModel;
  /** `model.getAlternativeVersionId()` of the content last loaded from or written to disk. */
  savedVersionId: number;
  /** Text last loaded from or written to disk. */
  savedText: string;
};

type DirtyListener = (path: string, isDirty: boolean) => void;

/**
 * The documents of one worktree. Models live under `file://<worktree>/<path>`, the URIs the language server knows
 * them by; every TypeScript model is kept in sync with the server (see lsp/client.ts). Opening a file also loads
 * the files it imports (one level) and shows them to the coloring worker, so identifiers from those files get
 * their semantic colors.
 */
export class Workspace {
  /** The worktree's language server client; sessions sharing the worktree share it. */
  readonly lsp: LspClient;
  private readonly documents = new Map<string, Document>();
  private readonly loading = new Map<string, Promise<Document>>();
  private readonly dirtyListeners = new Set<DirtyListener>();
  /** Last reported dirty state per path, so listeners only hear changes. */
  private readonly reportedDirty = new Map<string, boolean>();
  /** Paths whose imports were resolved already; a document's imports are loaded once per content. */
  private readonly dependenciesLoadedFor = new Map<string, number>();
  /** HEAD content per path for the editor's change markers; dropped whenever the worktree changes. */
  private readonly headTexts = new Map<string, Promise<string | null>>();
  private readonly headListeners = new Set<() => void>();

  constructor(
    /** Session used for the IPC calls; sub chats share the worktree and may pass their own id. */
    public sessionId: string,
    readonly worktreePath: string,
  ) {
    this.lsp = lspClientFor(sessionId, worktreePath);
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

  isDirty(path: string): boolean {
    const document = this.documents.get(path);
    return !!document && document.model.getAlternativeVersionId() !== document.savedVersionId;
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

  /** Loads the file like `open` but without its imports, for callers that need only the document and its diagnostics. */
  load(path: string): Promise<Document> {
    const existing = this.documents.get(path);
    if (existing) return Promise.resolve(existing);
    const pending = this.loading.get(path);
    if (pending) return pending;

    const request = commands
      .readFile(this.sessionId, path)
      .then((text) => this.documents.get(path) ?? this.adopt(path, text))
      .finally(() => this.loading.delete(path));
    this.loading.set(path, request);
    return request;
  }

  /**
   * The document of `path` at once, for a view that has just read the file itself (a diff's editable side): a document
   * not loaded yet is created from `text`, a loaded one without unsaved edits takes `text` over, and unsaved edits stay.
   */
  documentFor(path: string, text: string): Document {
    const document = this.documents.get(path);
    if (!document) return this.adopt(path, text);
    if (!this.isDirty(path) && document.model.getValue() !== text) {
      this.replaceText(document, text);
    }
    return document;
  }

  /** Treats the content of `path` as saved, provided the model holds exactly `text` (written to disk by someone else, e.g. a diff). */
  markSaved(path: string, text: string): void {
    const document = this.documents.get(path);
    if (!document || document.model.getValue() !== text) return;
    document.savedText = text;
    document.savedVersionId = document.model.getAlternativeVersionId();
    this.reportDirty(document);
  }

  private adopt(path: string, text: string): Document {
    const uri = this.uriOf(path);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, monacoLanguage(path), uri);
    const document: Document = { path, model, savedVersionId: model.getAlternativeVersionId(), savedText: model.getValue() };
    this.documents.set(path, document);
    this.lsp.track(model);
    model.onDidChangeContent(() => this.reportDirty(document));
    return document;
  }

  private reportDirty(document: Document) {
    const isDirty = document.model.getAlternativeVersionId() !== document.savedVersionId;
    if (this.reportedDirty.get(document.path) === isDirty) return;
    this.reportedDirty.set(document.path, isDirty);
    for (const listener of this.dirtyListeners) {
      listener(document.path, isDirty);
    }
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

  /** Writes the model content to disk and marks the document clean. */
  async save(path: string): Promise<void> {
    const document = this.documents.get(path);
    if (!document) return;
    const text = document.model.getValue();
    const versionId = document.model.getAlternativeVersionId();
    await commands.writeFile(this.sessionId, path, text);
    document.savedText = text;
    document.savedVersionId = versionId;
    this.reportDirty(document);
    void this.loadDependencies(document);
  }

  /**
   * Asks before unsaved edits in `paths` are lost (closing their last tab) and reverts them on consent.
   * Returns false when the user keeps the edits, in which case nothing should close.
   */
  async discardIfConfirmed(paths: string[]): Promise<boolean> {
    const dirty = paths.filter((path) => this.isDirty(path));
    if (!dirty.length) return true;
    const names = dirty.map((path) => `"${baseName(path)}"`).join(", ");
    if (!(await confirmDestructive(`Discard unsaved changes in ${names}?`, "Discard"))) return false;
    for (const path of dirty) {
      this.revert(path);
    }
    return true;
  }

  /** Throws away unsaved edits of `path`; the model goes back to the content on disk. */
  revert(path: string): void {
    const document = this.documents.get(path);
    if (!document) return;
    this.replaceText(document, document.savedText);
  }

  /** Drops the document of a deleted file: its model is disposed and it no longer counts as dirty. */
  forget(path: string): void {
    const document = this.documents.get(path);
    if (!document) return;
    this.documents.delete(path);
    this.dependenciesLoadedFor.delete(path);
    if (this.reportedDirty.get(path)) {
      for (const listener of this.dirtyListeners) {
        listener(path, false);
      }
    }
    this.reportedDirty.delete(path);
    document.model.dispose();
  }

  /**
   * Re-reads the given documents, by default every loaded one, from disk after the worktree changed (agent edits,
   * reverts, unshelving). Loaded documents include imports and usage previews without a tab; the language server
   * reads them from their model, not from disk. Documents with unsaved edits keep them; a file that vanished keeps
   * its model until its tabs close.
   */
  async reloadFromDisk(paths: string[] = [...this.documents.keys()]): Promise<void> {
    this.headTexts.clear();
    for (const listener of this.headListeners) {
      listener();
    }
    await Promise.allSettled(
      paths.map(async (path) => {
        const document = this.documents.get(path);
        if (!document || this.isDirty(path)) return;
        const text = await commands.readFile(this.sessionId, path);
        if (text === document.model.getValue()) return;
        this.replaceText(document, text);
      }),
    );
  }

  /** Replaces the whole text as one undoable edit and treats the result as the saved state. */
  private replaceText(document: Document, text: string) {
    const model = document.model;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    document.savedText = text;
    document.savedVersionId = model.getAlternativeVersionId();
    this.reportDirty(document);
    this.dependenciesLoadedFor.delete(document.path);
  }
}

const workspaces = new Map<string, Workspace>();

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
