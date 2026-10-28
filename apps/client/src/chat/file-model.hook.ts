import { useMemo } from "react";
import type * as monaco from "monaco-editor";
import { workspaceFor } from "../ide/documents/documents.service";

/**
 * The loader of `FileModelContext` (editor/highlighted-code.hook.ts) for a chat in the local worktree `worktreePath`: it
 * opens the file among the worktree's documents with its imports, like the editor, so code the agent quotes from it is
 * colored like there. Null without a local worktree, as for remote sessions.
 */
export function useFileModelLoader(sessionId: string, worktreePath: string | undefined): ((path: string) => Promise<monaco.editor.ITextModel>) | null {
  return useMemo(() => {
    if (!worktreePath) return null;
    return async (path: string) => (await workspaceFor(sessionId, worktreePath).open(path)).model;
  }, [sessionId, worktreePath]);
}
