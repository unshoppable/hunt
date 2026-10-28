import { useRef, useState } from "react";
import { commands } from "../ipc/commands";
import { useHuntStore } from "../sessions/hunt.store";
import { useLoad } from "../ui/load.hook";
import { createFileIndex, type FileIndex } from "./file-links.utils";

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
