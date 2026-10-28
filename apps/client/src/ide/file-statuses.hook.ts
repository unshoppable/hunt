import { useState } from "react";
import { commands } from "../ipc/commands";
import { useLoad } from "../ui/load.hook";

const NONE: Readonly<Record<string, string>> = {};

/**
 * The git status letter (see `ChangedFile.status`) of every changed file of the session's worktree, keyed by
 * worktree-relative path; reloaded whenever `refreshVersion` changes. Files outside the changes have no entry, and
 * another session's statuses are never returned while the new ones load.
 */
export function useFileStatuses(sessionId: string, refreshVersion: number): Readonly<Record<string, string>> {
  const [loaded, setLoaded] = useState<{ sessionId: string; statusByPath: Record<string, string> } | null>(null);
  useLoad(
    () => commands.listChangedFiles(sessionId),
    { onValue: (files) => setLoaded({ sessionId, statusByPath: Object.fromEntries(files.map((file) => [file.path, file.status])) }), onError: () => {} },
    [sessionId, refreshVersion],
  );
  return loaded?.sessionId === sessionId ? loaded.statusByPath : NONE;
}
