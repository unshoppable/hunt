import { useCallback, useSyncExternalStore } from "react";
import type { Workspace } from "./documents";

const NONE: readonly string[] = [];

/** Paths of `workspace` with unsaved edits in any window, sorted and kept current; empty without a workspace. */
export function useDirtyPaths(workspace: Workspace | null): readonly string[] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!workspace) return () => undefined;
      const subscription = workspace.onDirtyChange(onChange);
      return () => subscription.dispose();
    },
    [workspace],
  );
  return useSyncExternalStore(subscribe, () => workspace?.dirtyPaths() ?? NONE);
}
