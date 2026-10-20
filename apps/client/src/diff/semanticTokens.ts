import * as monaco from "monaco-editor";
import { WEBSTORM_ROLES } from "./webstormRoles";

/** Monaco's TypeScript worker plus the methods added in semantic.worker.ts. */
export type SemanticWorker = monaco.typescript.TypeScriptWorker & {
  getSemanticClassifications(fileName: string): Promise<number[]>;
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
 * Classifies the identifiers of `model` with the WebStorm roles they resolve to (parameter, local variable, instance
 * field, static method, class, …) using the TypeScript language service in the worker (see semantic.worker.ts and
 * webstormClassifier.ts). Resolves to null when the worker is unavailable or the model changed or was disposed meanwhile.
 */
export async function classifyModel(model: monaco.editor.ITextModel): Promise<SemanticSpan[] | null> {
  const version = model.getVersionId();
  let classifications: number[];
  try {
    const worker = await typeScriptWorkerFor(model);
    if (!worker) return null;
    classifications = await worker.getSemanticClassifications(model.uri.toString());
  } catch {
    return null;
  }
  if (model.isDisposed() || model.getVersionId() !== version) return null;

  const spans: SemanticSpan[] = [];
  for (let index = 0; index < classifications.length; index += 3) {
    const role = classifications[index + 2];
    if (role < 0 || role >= WEBSTORM_ROLES.length) continue;
    spans.push({ start: classifications[index], length: classifications[index + 1], role });
  }
  return spans;
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
