import { TypeScriptWorker, initialize, ts } from "monaco-editor/languages/features/typescript/ts.worker.js";
import { classifyWebstorm } from "./webstormClassifier";

/** Monaco's TypeScript worker plus the WebStorm role classification the editors color identifiers with. */
class SemanticTypeScriptWorker extends TypeScriptWorker {
  /**
   * WebStorm roles of the identifiers of `fileName` as flat `[start, length, roleId, …]` triples; `roleId` indexes
   * `WEBSTORM_ROLES` (see webstormClassifier.ts). Empty when the file is unknown to the language service.
   */
  getSemanticClassifications(fileName: string): number[] {
    const program = this.getLanguageService().getProgram();
    const sourceFile = program?.getSourceFile(fileName);
    if (!program || !sourceFile) return [];
    return classifyWebstorm(ts.typescript, sourceFile, program.getTypeChecker());
  }
}

self.onmessage = () => {
  initialize((ctx, createData) => new SemanticTypeScriptWorker(ctx, createData));
};
