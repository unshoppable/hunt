import { useRef, useState } from "react";
import { commands } from "../ipc/commands";
import { useHuntStore } from "../state/store";
import { useLoad } from "../ui/useLoad";
import type { FileTarget } from "./changeReferences";

/** The files of a worktree: their worktree-relative paths, and the paths of each file name. */
export type FileIndex = { paths: ReadonlySet<string>; pathsByName: ReadonlyMap<string, string[]> };

/** Inline code naming a file: the path, then optionally the first and last line (each with an optional `L`) and a column. */
const INLINE_REFERENCE = /^([^\s:]+?)(?::L?(\d+)(?:\s*[-–]\s*L?(\d+))?(?::\d+)?)?$/;

export function createFileIndex(paths: string[]): FileIndex {
  const pathsByName = new Map<string, string[]>();
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    pathsByName.set(name, [...(pathsByName.get(name) ?? []), path]);
  }
  return { paths: new Set(paths), pathsByName };
}

/**
 * The file that the inline code `text` names as `path`, `path:line` or `path:start-end`: a worktree-relative path, an
 * absolute one inside the worktree at `basePath`, or the end of exactly one worktree path (`b/c.ts` for `a/b/c.ts`).
 * Null for anything else, also for a path that fits several files.
 */
export function resolveFileReference(text: string, index: FileIndex, basePath: string): FileTarget | null {
  const match = text.trim().match(INLINE_REFERENCE);
  if (!match) return null;
  const path = basePath && match[1].startsWith(`${basePath}/`) ? match[1].slice(basePath.length + 1) : match[1].replace(/^\.\//, "");
  if (path.startsWith("/") || !/[./]/.test(path)) return null;
  const resolved = index.paths.has(path) ? path : uniqueSuffixMatch(path, index);
  if (!resolved) return null;
  if (!match[2]) return { path: resolved };
  const startLine = Number(match[2]);
  return startLine > 0 ? { path: resolved, startLine, endLine: Math.max(startLine, Number(match[3] ?? startLine)) } : { path: resolved };
}

function uniqueSuffixMatch(path: string, index: FileIndex): string | null {
  const candidates = (index.pathsByName.get(path.slice(path.lastIndexOf("/") + 1)) ?? []).filter((candidate) => candidate.endsWith(`/${path}`));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * The file index of the worktree of `sessionId`, loaded again after its agent changed files; null while the first
 * load runs, without a session, or when the files cannot be listed (inline code then shows no links).
 */
export function useFileIndex(sessionId: string | null): FileIndex | null {
  const editVersion = useHuntStore((state) => (sessionId ? state.chats[sessionId]?.editVersion : undefined) ?? 0);
  const [loaded, setLoaded] = useState<{ sessionId: string; index: FileIndex } | null>(null);
  const hasLoadedRef = useRef(false);
  useLoad(
    () => {
      hasLoadedRef.current = true;
      return commands.listFiles(sessionId ?? "");
    },
    {
      onValue: (paths) => setLoaded(sessionId ? { sessionId, index: createFileIndex(paths) } : null),
      onError: (reason) => console.warn("failed to list the worktree files:", reason),
    },
    [sessionId, editVersion],
    { delayMs: hasLoadedRef.current ? 300 : 0, isEnabled: !!sessionId },
  );
  return loaded && loaded.sessionId === sessionId ? loaded.index : null;
}
