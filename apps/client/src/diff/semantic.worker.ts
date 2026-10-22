import { TypeScriptWorker, initialize, ts } from "monaco-editor/languages/features/typescript/ts.worker.js";
import { classifyWebstorm, type WebstormClassification } from "./webstormClassifier";
import { isObjectMemberPosition } from "../ide/lsp/completionContext";

/**
 * Monaco's TypeScript worker plus the WebStorm role classification the editors color identifiers with and the syntax
 * check that lets completion lists open at object members.
 */
class SemanticTypeScriptWorker extends TypeScriptWorker {
  /**
   * WebStorm roles of the identifiers of `fileName` and the imports it cannot resolve (see webstormClassifier.ts);
   * `importRoles` holds the roles of such imports looked up elsewhere. Empty when the file is unknown to the language service.
   */
  getSemanticClassifications(fileName: string, importRoles: Record<string, number>): WebstormClassification {
    const program = this.getLanguageService().getProgram();
    const sourceFile = program?.getSourceFile(fileName);
    if (!program || !sourceFile) return { classifications: [], unresolvedImports: [] };
    return classifyWebstorm(ts.typescript, sourceFile, program.getTypeChecker(), importRoles);
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
