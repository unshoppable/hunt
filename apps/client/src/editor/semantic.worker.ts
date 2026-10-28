import { TypeScriptWorker, initialize, ts } from "monaco-editor/languages/features/typescript/ts.worker.js";
import { classifyWebstorm, type WebstormClassification } from "./webstorm-classifier.utils";
import { isObjectMemberPosition } from "../ide/lsp/completion-context.utils";
import { unusedMemberCandidates, type MemberCandidate } from "../ide/language/unused-members.utils";

/**
 * Monaco's TypeScript worker plus the WebStorm role classification the editors color identifiers with, the syntax
 * check that lets completion lists open at object members and the class members whose usages the editor looks up.
 */
class SemanticTypeScriptWorker extends TypeScriptWorker {
  /**
   * WebStorm roles of the identifiers of `fileName` and the imports it cannot resolve (see webstorm-classifier.utils.ts);
   * `importRoles` holds the roles of such imports looked up elsewhere. Empty when the file is unknown to the language service.
   */
  getSemanticClassifications(fileName: string, importRoles: Record<string, number>): WebstormClassification {
    const program = this.getLanguageService().getProgram();
    const sourceFile = program?.getSourceFile(fileName);
    if (!program || !sourceFile) return { classifications: [], unresolvedImports: [] };
    return classifyWebstorm(ts.typescript, sourceFile, program.getTypeChecker(), importRoles);
  }

  /** Whether a member of an object literal or destructuring pattern starts at `offset` (see ide/lsp/completion-context.utils.ts). */
  isObjectMemberPosition(fileName: string, offset: number): boolean {
    const sourceFile = this.getLanguageService().getProgram()?.getSourceFile(fileName);
    return !!sourceFile && isObjectMemberPosition(ts.typescript, sourceFile, offset);
  }

  /** The class members of `fileName` that may be unused (see ide/language/unused-members.utils.ts); empty when the file is unknown. */
  unusedMemberCandidates(fileName: string): MemberCandidate[] {
    const sourceFile = this.getLanguageService().getProgram()?.getSourceFile(fileName);
    return sourceFile ? unusedMemberCandidates(ts.typescript, sourceFile) : [];
  }
}

self.onmessage = () => {
  initialize((ctx, createData) => new SemanticTypeScriptWorker(ctx, createData));
};
