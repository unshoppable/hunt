import type { IdeSession } from "../ide/ide.store";
import type { Pane } from "../ide/pane-layout.value-object";

/** The Editor tab as `hunt-client editor` reports it: its panes with their tabs (worktree-relative), the active pane, the files with unsaved edits, whether back and forward lead anywhere. */
export type EditorState = { panes: Pane[]; activePaneId: string | null; dirty: readonly string[]; canGoBack: boolean; canGoForward: boolean };

/** The pane of `panes` that has a tab of `path`: the active one `activePaneId` when it has, else the first; `null` when none has. */
export function paneHolding(panes: readonly Pane[], activePaneId: string | null, path: string): Pane | null {
  const holding = panes.filter((pane) => pane.tabs.includes(path));
  return holding.find((pane) => pane.id === activePaneId) ?? holding[0] ?? null;
}

/** What `hunt-client editor` reports of `session`, with `dirty` the files that have unsaved edits. */
export function editorState(session: IdeSession, dirty: readonly string[]): EditorState {
  const panes = session.layout.panes.map(({ id, tabs, activePath }) => ({ id, tabs: [...tabs], activePath }));
  return { panes, activePaneId: session.activePaneId, dirty, canGoBack: session.history.back.length > 0, canGoForward: session.history.forward.length > 0 };
}
