import * as monaco from "monaco-editor";
import { typeScriptWorkerFor } from "../../editor/semantic-tokens.monaco";
import { loadProjectsMentioning } from "./language-service.utils";
import { lspClientForModel, type LspClient } from "../lsp/lsp-client.service";
import { toLspRange, type Location, type Range } from "../lsp/lsp-protocol.utils";
import { isOnlyDeclaration, siblingTemplatePath, unusedMemberMessage } from "./unused-members.utils";

/** Owner of the unused-member markers, apart from the language server's diagnostics, which replace their own markers. */
const MARKER_OWNER = "unused-members";
/** Pause after the last edit, or after the editor got focus, before the members are looked up again. */
const LOOKUP_DELAY_MS = 1000;

/**
 * Underlines the class members of the shown file that nothing uses, like WebStorm's "Unused property": the TypeScript
 * worker names the members that may be unused (see unused-members.utils.ts), the TypeScript server and then the Angular
 * server (templates) look up their references, and only a member neither finds is searched in the projects of every
 * file mentioning its name (see `isUnused`). The markers of a file are set once every member is decided, so a member
 * used only in a template is never marked in between. Looked up whenever the shown model changes, shortly after
 * every edit and whenever the editor gets focus, since the usages may have changed in other files.
 */
export class UnusedMemberMarkers {
  private readonly disposables: monaco.IDisposable[] = [];
  private contentSubscription: monaco.IDisposable | null = null;
  private lookupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cancels the server requests of the running lookup. */
  private cancellation: monaco.CancellationTokenSource | null = null;

  constructor(private readonly editor: monaco.editor.ICodeEditor) {
    this.disposables.push(
      editor.onDidChangeModel(() => this.trackModel()),
      editor.onDidFocusEditorText(() => this.scheduleLookup()),
    );
    this.trackModel();
  }

  dispose(): void {
    this.cancelLookup();
    this.contentSubscription?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private trackModel(): void {
    this.cancelLookup();
    this.contentSubscription?.dispose();
    this.contentSubscription = null;
    const model = this.editor.getModel();
    if (!model) return;
    this.contentSubscription = model.onDidChangeContent(() => this.scheduleLookup());
    this.scheduleLookup();
  }

  private scheduleLookup(): void {
    this.cancelLookup();
    this.lookupTimer = setTimeout(() => {
      this.lookupTimer = null;
      const model = this.editor.getModel();
      if (!model) return;
      const cancellation = new monaco.CancellationTokenSource();
      this.cancellation = cancellation;
      void markUnusedMembers(model, cancellation.token)
        .catch(() => {})
        .finally(() => cancellation.dispose());
    }, LOOKUP_DELAY_MS);
  }

  private cancelLookup(): void {
    if (this.lookupTimer) {
      clearTimeout(this.lookupTimer);
      this.lookupTimer = null;
    }
    this.cancellation?.cancel();
    this.cancellation = null;
  }
}

/** Replaces the unused-member markers of `model`; does nothing for models the language server does not serve. */
async function markUnusedMembers(model: monaco.editor.ITextModel, token: monaco.CancellationToken): Promise<void> {
  const client = lspClientForModel(model);
  if (!client) return;
  const version = model.getVersionId();
  const worker = await typeScriptWorkerFor(model);
  if (!worker) return;
  const candidates = await worker.unusedMemberCandidates(model.uri.toString());
  const ranges = candidates.map((candidate) =>
    candidate.declarations.map((declaration) => monaco.Range.fromPositions(model.getPositionAt(declaration.start), model.getPositionAt(declaration.end))),
  );
  const unused = await Promise.all(candidates.map((candidate, index) => isUnused(client, model, ranges[index].map(toLspRange), candidate.name, token)));
  if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return;
  const markers = candidates.flatMap((candidate, index) =>
    unused[index] ? ranges[index].map((range) => ({ ...range, message: unusedMemberMessage(candidate), severity: monaco.MarkerSeverity.Hint, tags: [monaco.MarkerTag.Unnecessary] })) : [],
  );
  monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
}

/**
 * Whether the member declared at `declarations` has no usage: neither in the TypeScript server's loaded projects, nor
 * in a template the Angular server knows, nor (asked only when both found nothing) in the projects of the files
 * mentioning `name` or in the template beside the member's file. A failed Angular request counts as no template
 * usage, as in the usages popup.
 */
async function isUnused(client: LspClient, model: monaco.editor.ITextModel, declarations: Range[], name: string, token: monaco.CancellationToken): Promise<boolean> {
  const uri = model.uri.toString();
  const params = { textDocument: { uri }, position: declarations[0].start, context: { includeDeclaration: true } };
  const references = () => client.request<Location[] | null>("textDocument/references", params, token).then((locations) => locations ?? []);
  if (!isOnlyDeclaration(await references(), uri, declarations)) return false;
  const templateReferences = await client.request<Location[] | null>("textDocument/references", params, token, "angular").catch(() => null);
  if (!isOnlyDeclaration(templateReferences ?? [], uri, declarations)) return false;
  const mentioningPaths = await loadProjectsMentioning(client, name);
  const template = siblingTemplatePath(model.uri.path.slice(client.worktreePath.length + 1));
  if (template && mentioningPaths.includes(template)) return false;
  return isOnlyDeclaration(await references(), uri, declarations);
}
