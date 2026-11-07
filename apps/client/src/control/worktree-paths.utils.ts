import type { SessionView } from "../sessions/session.types";
import { worktreeFilePath } from "./control-command.utils";

export const NO_LOCAL_WORKTREE = "the session has no local worktree";

/** The absolute `paths` relative to the worktree of `session`; throws when there are paths but no local worktree, or one lies outside it. */
export function localWorktreePaths(session: SessionView, paths: readonly string[]): string[] {
  if (paths.length && !session.hasLocalWorktree) throw new Error(NO_LOCAL_WORKTREE);
  return paths.map((path) => worktreeFilePath(path, session.worktreePath));
}

/** The worktree-relative `paths` that `known` lacks, in their order. */
export function unknownPaths(paths: readonly string[], known: Iterable<string>): string[] {
  const knownPaths = new Set(known);
  return paths.filter((path) => !knownPaths.has(path));
}
