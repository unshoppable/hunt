import * as monaco from "monaco-editor";
import { lspClientForModel } from "../ide/lsp/client";
import { hoverSignature, toLspPosition, type Hover } from "../ide/lsp/protocol";
import { roleOfImportHover, type UnresolvedImport, type WebstormClassification } from "./webstormClassifier";
import { WEBSTORM_ROLES } from "./webstormRoles";

/** Monaco's TypeScript worker plus the methods added in semantic.worker.ts. */
export type SemanticWorker = monaco.typescript.TypeScriptWorker & {
  getSemanticClassifications(fileName: string, importRoles: Record<string, number>): Promise<WebstormClassification>;
  isObjectMemberPosition(fileName: string, offset: number): Promise<boolean>;
};

/**
 * The TypeScript worker for `model` (null for other languages), with the models in `alsoSync` visible to it as
 * well (cross-file lookups only see synced models). Monaco sets the worker up asynchronously after
 * the first model of the language appears and rejects with "TypeScript not registered!" until then, so the
 * request is retried.
 */
export async function typeScriptWorkerFor(model: monaco.editor.ITextModel, alsoSync: monaco.Uri[] = []): Promise<SemanticWorker | null> {
  const languageId = model.getLanguageId();
  if (languageId !== "typescript" && languageId !== "javascript") return null;
  const languageWorker = languageId === "javascript" ? monaco.typescript.getJavaScriptWorker : monaco.typescript.getTypeScriptWorker;
  for (let attempt = 0; ; attempt++) {
    try {
      return (await (await languageWorker())(model.uri, ...alsoSync)) as unknown as SemanticWorker;
    } catch (error) {
      if (attempt >= 100 || model.isDisposed()) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** One classified identifier: `start` and `length` are offsets into the text, `role` indexes `WEBSTORM_ROLES`. */
export type SemanticSpan = { start: number; length: number; role: number };

/** Theme token name of a span: its WebStorm role name (`instanceMethod`, `parameter`, …). */
export function semanticTokenName(span: SemanticSpan): string {
  return WEBSTORM_ROLES[span.role];
}

/**
 * Role ids of the imports the worker cannot resolve (path aliases, packages), by import key, as the language server
 * reported them for a model; -1 when it named no role. Keys being looked up are in `pendingImports`.
 */
const importRoles = new WeakMap<monaco.editor.ITextModel, Record<string, number>>();
const pendingImports = new WeakMap<monaco.editor.ITextModel, Set<string>>();

/**
 * Classifies the identifiers of `model` with the WebStorm roles they resolve to (parameter, local variable, instance
 * field, static method, class, …) using the TypeScript language service in the worker (see semantic.worker.ts and
 * webstormClassifier.ts). Imports the worker cannot resolve are looked up from the language server of a worktree
 * model in the background, and the tokens are refreshed once their roles are in. Resolves to null when the worker is
 * unavailable or the model changed or was disposed meanwhile.
 */
export async function classifyModel(model: monaco.editor.ITextModel): Promise<SemanticSpan[] | null> {
  const version = model.getVersionId();
  let classification: WebstormClassification;
  try {
    const worker = await typeScriptWorkerFor(model);
    if (!worker) return null;
    classification = await worker.getSemanticClassifications(model.uri.toString(), importRoles.get(model) ?? {});
  } catch {
    return null;
  }
  if (model.isDisposed() || model.getVersionId() !== version) return null;
  if (classification.unresolvedImports.length) {
    void lookUpImportRoles(model, classification.unresolvedImports);
  }

  const { classifications } = classification;
  const spans: SemanticSpan[] = [];
  for (let index = 0; index < classifications.length; index += 3) {
    const role = classifications[index + 2];
    if (role < 0 || role >= WEBSTORM_ROLES.length) continue;
    spans.push({ start: classifications[index], length: classifications[index + 1], role });
  }
  return spans;
}

/**
 * Asks the language server for the kind of each import in `imports` (its hover reads `(alias) interface Foo`) and
 * refreshes the tokens when one got a role. Imports of models the server does not serve keep the grammar's color.
 */
async function lookUpImportRoles(model: monaco.editor.ITextModel, imports: UnresolvedImport[]): Promise<void> {
  const client = lspClientForModel(model);
  if (!client) return;
  const roles = importRoles.get(model) ?? {};
  importRoles.set(model, roles);
  const pending = pendingImports.get(model) ?? new Set<string>();
  pendingImports.set(model, pending);

  const lookups = imports
    .filter((unresolvedImport) => !pending.has(unresolvedImport.key))
    .map(async (unresolvedImport) => {
      pending.add(unresolvedImport.key);
      const position = toLspPosition(model.getPositionAt(unresolvedImport.offset));
      try {
        const hover = await client.request<Hover | null>("textDocument/hover", { textDocument: { uri: model.uri.toString() }, position });
        const role = hover ? roleOfImportHover(hoverSignature(hover)) : null;
        roles[unresolvedImport.key] = role ? WEBSTORM_ROLES.indexOf(role) : -1;
      } catch {
        roles[unresolvedImport.key] = -1;
      } finally {
        pending.delete(unresolvedImport.key);
      }
    });
  if (!lookups.length) return;
  await Promise.all(lookups);
  if (model.isDisposed() || !imports.some((unresolvedImport) => roles[unresolvedImport.key] >= 0)) return;
  refreshSemanticTokens();
}

const tokensChanged = new monaco.Emitter<void>();

/**
 * Makes the editors request their semantic tokens again, for when more files became visible to the worker
 * (imports resolve to their targets' roles only once the imported models are synced).
 */
export function refreshSemanticTokens(): void {
  tokensChanged.fire();
}

/** Registers `classifyModel` as the semantic token provider of the Monaco editors; the Monarch grammar only sees syntax. */
export function registerSemanticTokens(): void {
  monaco.languages.registerDocumentSemanticTokensProvider(["typescript", "javascript"], {
    onDidChange: tokensChanged.event,
    getLegend: () => ({ tokenTypes: [...WEBSTORM_ROLES], tokenModifiers: [] }),
    releaseDocumentSemanticTokens: () => {},
    provideDocumentSemanticTokens: async (model) => {
      const spans = await classifyModel(model);
      if (!spans) return null;

      const data: number[] = [];
      let previousLine = 0;
      let previousColumn = 0;
      for (const span of spans) {
        const position = model.getPositionAt(span.start);
        const line = position.lineNumber - 1;
        const column = position.column - 1;
        data.push(line - previousLine, line === previousLine ? column - previousColumn : column, span.length, span.role, 0);
        previousLine = line;
        previousColumn = column;
      }
      return { data: new Uint32Array(data) };
    },
  });
}
