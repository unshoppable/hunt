import { baseName, dirName } from "../common/path/path.utils";
import { EMPTY_IDE_SESSION, useIdeStore } from "../ide/ide.store";
import { commands } from "../ipc/commands";
import { useSessionViewStore } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import { worktreeFilePath } from "./control-command.utils";
import { editorState, paneHolding } from "./editor-commands.utils";
import type { EditorAction } from "./tab-commands.utils";

const NO_LOCAL_WORKTREE = "the session has no local worktree";

/**
 * Runs `action` on the Editor tab of `session` and shows that tab; without an action resolves to the tab's state, as
 * `hunt-client editor` prints it. Closing and activating act on the pane that has the file open, the active one first.
 */
export async function runEditorCommand(session: SessionView, action: EditorAction | undefined): Promise<unknown> {
  if (!action) return readEditorState(session);
  const ide = useIdeStore.getState();
  const editor = ide.sessions[session.id] ?? EMPTY_IDE_SESSION;
  switch (action.name) {
    case "close": {
      const { paneId, path } = openTab(session, action.path);
      ide.closeTab(session.id, paneId, path);
      break;
    }
    case "closeAll":
      ide.closeAllTabs(session.id);
      break;
    case "activate": {
      const { paneId, path } = openTab(session, action.path);
      ide.activateTab(session.id, paneId, path);
      break;
    }
    case "back":
      if (!editor.history.back.length) throw new Error("there is nothing to go back to");
      ide.navigateBack(session.id);
      break;
    case "forward":
      if (!editor.history.forward.length) throw new Error("there is nothing to go forward to");
      ide.navigateForward(session.id);
      break;
    case "reveal":
      await reveal(session, action.path);
      break;
  }
  useSessionViewStore.getState().setTab(session.id, "editor");
}

/** The pane that has the file at the absolute `path` open, with the file's worktree-relative path; throws when no pane has. */
function openTab(session: SessionView, absolutePath: string): { paneId: string; path: string } {
  if (!session.hasLocalWorktree) throw new Error(NO_LOCAL_WORKTREE);
  const path = worktreeFilePath(absolutePath, session.worktreePath);
  const editor = useIdeStore.getState().sessions[session.id] ?? EMPTY_IDE_SESSION;
  const pane = paneHolding(editor.layout.panes, editor.activePaneId, path);
  if (!pane) throw new Error(`${absolutePath} is not open in the editor; open it with hunt-client open file`);
  return { paneId: pane.id, path };
}

/** Reveals the absolute `path` in the project tree, the active file without one: a folder is expanded and selected, a file selected. */
async function reveal(session: SessionView, absolutePath: string | undefined): Promise<void> {
  const ide = useIdeStore.getState();
  if (!absolutePath) {
    const editor = ide.sessions[session.id] ?? EMPTY_IDE_SESSION;
    if (!editor.activePaneId || !editor.layout.findPane(editor.activePaneId)) throw new Error("no file is active in the editor");
    ide.revealActiveFile(session.id);
    return;
  }
  if (!session.hasLocalWorktree) throw new Error(NO_LOCAL_WORKTREE);
  const path = worktreeFilePath(absolutePath, session.worktreePath);
  const entries = await commands.listDir(session.id, dirName(path));
  const entry = entries.find((candidate) => candidate.name === baseName(path));
  if (!entry) throw new Error(`the project tree has no ${absolutePath}`);
  if (entry.isDir) {
    ide.revealFolder(session.id, path);
  } else {
    ide.revealFile(session.id, path);
  }
}

/** The Editor tab of `session`; the files with unsaved edits come from the backend, which holds them for every window. */
async function readEditorState(session: SessionView) {
  const editor = useIdeStore.getState().sessions[session.id] ?? EMPTY_IDE_SESSION;
  const dirty = session.hasLocalWorktree ? await commands.dirtyDocuments(session.id) : [];
  return editorState(editor, dirty);
}
