import { TypeScriptWorker, initialize, ts } from "monaco-editor/languages/features/typescript/ts.worker.js";
import { classifyWebstorm } from "./webstormClassifier";
import { isObjectMemberPosition } from "../ide/lsp/completionContext";

/**
 * Monaco's TypeScript worker plus the WebStorm role classification the editors color identifiers with and the syntax
 * check that lets completion lists open at object members.
 */
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

  /** Whether a member of an object literal or destructuring pattern starts at `offset` (see ide/lsp/completionContext.ts). */
  isObjectMemberPosition(fileName: string, offset: number): boolean {
    const sourceFile = this.getLanguageService().getProgram()?.getSourceFile(fileName);
    return !!sourceFile && isObjectMemberPosition(ts.typescript, sourceFile, offset);
  }
}

self.onmessage = () => {
  initialize((ctx, createData) => new SemanticTypeScriptWorker(ctx, createData));
};
