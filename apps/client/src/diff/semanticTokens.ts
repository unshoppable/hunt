import * as monaco from "monaco-editor";
import { lspClientForModel, lspClientForTemplate } from "../ide/lsp/client";
import { hoverSignature, toLspPosition, type Hover } from "../ide/lsp/protocol";
import { TEMPLATE_ROLES, templateRoleOfHover, type TemplateRole } from "./angularTemplate";
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
    const source = importRoleSources.get(model);
    if (source && classification.unresolvedImports.length) {
      const roles = await borrowedImportRoles(model, source, classification.unresolvedImports);
      if (roles) {
        classification = await worker.getSemanticClassifications(model.uri.toString(), roles);
      }
    }
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

/** The model each model borrows the roles of its unresolved imports from (see `borrowImportRoles`). */
const importRoleSources = new WeakMap<monaco.editor.ITextModel, monaco.editor.ITextModel>();

/**
 * Colors each import of `model` that neither the worker nor the language server can resolve like the identifier of
 * the same name in `source`. For the base revision of a diff, whose model has no path and whose imports may point to
 * files that no longer exist, with the current side as `source`.
 */
export function borrowImportRoles(model: monaco.editor.ITextModel, source: monaco.editor.ITextModel): void {
  importRoleSources.set(model, source);
}

/** `importRoles` of `model` plus a role for each of `imports`: the role of the first identifier in `source` with its local name, else -1. */
async function borrowedImportRoles(
  model: monaco.editor.ITextModel,
  source: monaco.editor.ITextModel,
  imports: UnresolvedImport[],
): Promise<Record<string, number> | null> {
  const sourceSpans = await classifyModel(source);
  if (!sourceSpans || model.isDisposed()) return null;
  const sourceText = source.getValue();
  const rolesByName = new Map<string, number>();
  for (const span of sourceSpans) {
    const name = sourceText.slice(span.start, span.start + span.length);
    if (!rolesByName.has(name)) {
      rolesByName.set(name, span.role);
    }
  }
  const roles = { ...importRoles.get(model) };
  for (const unresolvedImport of imports) {
    const name = model.getWordAtPosition(model.getPositionAt(unresolvedImport.offset))?.word;
    roles[unresolvedImport.key] = (name ? rolesByName.get(name) : undefined) ?? -1;
  }
  return roles;
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

/** Token of the template grammar (angularTemplate.ts) for a name at the top of an expression. */
const TEMPLATE_NAME_TOKEN = "identifier.ng.html";

/**
 * Classifies the names at the top of the expressions of an Angular template (`displayName` in `{{ displayName() }}`)
 * by asking the Angular language server what each one is (see `templateRoleOfHover`); `role` indexes
 * `TEMPLATE_ROLES`. Null for models outside a worktree, when the worktree has no Angular, and when the model changed
 * or was disposed meanwhile. The server loads the project on its first request, which takes a few seconds.
 */
async function classifyTemplate(model: monaco.editor.ITextModel, token: monaco.CancellationToken): Promise<SemanticSpan[] | null> {
  const client = lspClientForTemplate(model);
  if (!client) return null;
  const version = model.getVersionId();
  const names: { start: number; length: number; position: monaco.IPosition }[] = [];
  monaco.editor.tokenize(model.getValue(), "html").forEach((lineTokens, lineIndex) => {
    const lineNumber = lineIndex + 1;
    lineTokens.forEach((lineToken, index) => {
      if (lineToken.type !== TEMPLATE_NAME_TOKEN) return;
      const end = lineTokens[index + 1]?.offset ?? model.getLineMaxColumn(lineNumber) - 1;
      const position = { lineNumber, column: lineToken.offset + 1 };
      names.push({ start: model.getOffsetAt(position), length: end - lineToken.offset, position });
    });
  });

  if (!names.length) return [];

  const uri = model.uri.toString();
  const roleOf = async (position: monaco.IPosition) => {
    const params = { textDocument: { uri }, position: toLspPosition(position) };
    const hover = await client.request<Hover | null>("textDocument/hover", params, token, "angular");
    return hover ? templateRoleOfHover(hoverSignature(hover)) : null;
  };
  // The first answer tells whether the worktree has an Angular server at all; the other names only ask a running one.
  let roles: (TemplateRole | null)[];
  try {
    roles = [await roleOf(names[0].position)];
  } catch {
    return null;
  }
  roles.push(...(await Promise.all(names.slice(1).map((name) => roleOf(name.position).catch(() => null)))));
  if (model.isDisposed() || model.getVersionId() !== version || token.isCancellationRequested) return null;
  return names.flatMap((name, index) => {
    const role = roles[index];
    return role ? [{ start: name.start, length: name.length, role: TEMPLATE_ROLES.indexOf(role) }] : [];
  });
}

/** Encodes `spans` (ordered by offset) as Monaco's relative semantic token data. */
function encodeSpans(model: monaco.editor.ITextModel, spans: readonly SemanticSpan[]): monaco.languages.SemanticTokens {
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
}

/**
 * Registers `classifyModel` as the semantic token provider of the TypeScript and JavaScript editors and
 * `classifyTemplate` as the one of the HTML editors; the Monarch grammars only see syntax.
 */
export function registerSemanticTokens(): void {
  monaco.languages.registerDocumentSemanticTokensProvider(["typescript", "javascript"], {
    onDidChange: tokensChanged.event,
    getLegend: () => ({ tokenTypes: [...WEBSTORM_ROLES], tokenModifiers: [] }),
    releaseDocumentSemanticTokens: () => {},
    provideDocumentSemanticTokens: async (model) => {
      const spans = await classifyModel(model);
      return spans ? encodeSpans(model, spans) : null;
    },
  });
  monaco.languages.registerDocumentSemanticTokensProvider("html", {
    getLegend: () => ({ tokenTypes: [...TEMPLATE_ROLES], tokenModifiers: [] }),
    releaseDocumentSemanticTokens: () => {},
    provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
      const spans = await classifyTemplate(model, token);
      return spans ? encodeSpans(model, spans) : null;
    },
  });
}
