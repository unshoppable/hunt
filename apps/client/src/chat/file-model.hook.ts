import { useMemo } from "react";
import type * as monaco from "monaco-editor";
import { workspaceFor } from "../ide/documents/documents.service";

/**
 * The loader of `FileModelContext` (editor/highlighted-code.hook.ts) for the local worktree `worktreePath`: it opens the
 * file among the worktree's documents with its imports, like the editor, so code quoted from it (in a chat, a diff or a
 * search list) is colored like there. It takes worktree-relative paths and absolute ones inside the worktree (those of
 * the agent's tool calls). Null without a local worktree, as for remote sessions.
 */
export function useFileModelLoader(sessionId: string, worktreePath: string | undefined): ((path: string) => Promise<monaco.editor.ITextModel>) | null {
  return useMemo(() => {
    if (!worktreePath) return null;
    return async (path: string) => {
      const relativePath = path.startsWith(`${worktreePath}/`) ? path.slice(worktreePath.length + 1) : path;
      if (relativePath.startsWith("/")) throw new Error(`${path} is outside the worktree`);
      return (await workspaceFor(sessionId, worktreePath).open(relativePath)).model;
    };
  }, [sessionId, worktreePath]);
}
