import { useEffect, useMemo, useRef, useState } from "react";
import { fillPrompt } from "../../../../libs/domain/src/shared/prompts.utils.ts";
import projectTreeFilePrompt from "../../prompts/project-tree-file.system-prompt.md?raw";
import projectTreeFolderPrompt from "../../prompts/project-tree-folder.system-prompt.md?raw";
import { SubChatPopover } from "../chat/sub-chat/SubChatPopover";
import { useSubChatPopover } from "../chat/sub-chat/sub-chat-popover.hook";
import { commands } from "../ipc/commands";
import { PaneSeparator, Panel, PersistentGroup } from "../ui/ResizablePanes";
import { useHuntStore } from "../sessions/hunt.store";
import { repoName } from "../common/path/path.utils";
import { isShortcut, shortcutCommand } from "../ui/shortcuts.utils";
import { errorText } from "../ui/error-text.utils";
import { DependencyBanner } from "./DependencyBanner";
import { workspaceFor } from "./documents/documents.service";
import { EditorGrid } from "./EditorGrid";
import { EMPTY_IDE_SESSION, useIdeSession, useIdeStore } from "./ide.store";
import { ProjectTree, type ProjectTreeTarget } from "./project-tree/ProjectTree";
import { selectionChatsFor } from "./selection/selection-chats.utils";
import { useDirtyPaths } from "./documents/dirty-paths.hook";
import { useFileStatuses } from "./file-statuses.hook";

/** Events of the mouse's extra buttons that the editor and the webview must not act on. */
const MOUSE_BUTTON_EVENTS = ["mousedown", "mouseup", "auxclick"] as const;

/** The keymap commands the editor handles; their default bindings are listed below. */
const IDE_COMMANDS = [
  "editor.back",
  "editor.forward",
  "editor.selectInTree",
  "editor.closeTab",
  "editor.closeAllTabs",
  "editor.moveTabLeft",
  "editor.moveTabRight",
  "editor.moveTabUp",
  "editor.moveTabDown",
] as const;

/** Text fields other than Monaco's own input (the chat prompt, a review comment box) keep their own ⌘ shortcuts. */
function isForeignTextField(root: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (root?.contains(active) && active.closest(".monaco-editor")) return false;
  return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || (active as HTMLElement).isContentEditable;
}

/**
 * The built-in editor: project tree on the left, editor panes on the right. Shortcuts: ⌘E / ⌘R move the active
 * tab to the pane on the left / right, ⇧⌘E / ⇧⌘R to the pane above / below (creating one when needed),
 * ⌘W closes the active tab (and its pane when it was the last one), ⇧⌘W closes every tab; the empty editor area
 * stays until ⌘W is pressed once more, which calls `onCloseEmpty` (the editor window closes then). ⇧⌘2 selects the active file in the project
 * tree. The tree selection follows ⇧⌘2 only, never the active pane. ⌘S saves every file with unsaved edits, also with the
 * focus in the project tree (see `DocumentWorkspace.saveAll`). ⌘[ / ⌘] (also ⌥⌘← / ⌥⌘→) and the mouse's back / forward buttons step through the
 * navigation history. ⌃⇧C copies the active file's absolute path, in the project tree the paths of the selected rows.
 */
export function IdePanel({ sessionId, onCloseEmpty }: { sessionId: string; onCloseEmpty?: () => void }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const ide = useIdeSession(sessionId);
  const openFile = useIdeStore((state) => state.openFile);
  const moveActiveTab = useIdeStore((state) => state.moveActiveTab);
  const revealActiveFile = useIdeStore((state) => state.revealActiveFile);
  const closeTab = useIdeStore((state) => state.closeTab);
  const closeAllTabs = useIdeStore((state) => state.closeAllTabs);
  const navigateBack = useIdeStore((state) => state.navigateBack);
  const navigateForward = useIdeStore((state) => state.navigateForward);
  const rootRef = useRef<HTMLDivElement>(null);
  const subChat = useSubChatPopover();
  const closeSubChat = subChat.close;

  useEffect(() => closeSubChat(), [sessionId, closeSubChat]);

  const worktreePath = session?.worktreePath ?? "";
  const workspace = useMemo(() => workspaceFor(sessionId, worktreePath), [sessionId, worktreePath]);

  // Closing tabs keeps their unsaved edits in the shared documents; the project tree and the change list mark them.
  const dirtyPaths = useDirtyPaths(workspace);
  // The project tree and the editor tabs color changed files like the changelist.
  const statusByPath = useFileStatuses(sessionId, editVersion);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void workspace.reloadFromDisk();
  }, [workspace, editVersion]);

  const closeActiveTab = () => {
    const { layout, activePaneId } = useIdeStore.getState().sessions[sessionId] ?? EMPTY_IDE_SESSION;
    const pane = activePaneId ? layout.findPane(activePaneId) : null;
    if (!pane?.activePath) {
      onCloseEmpty?.();
      return;
    }
    closeTab(sessionId, pane.id, pane.activePath);
  };

  const closeEverything = () => closeAllTabs(sessionId);
  const closeActions = useRef({ closeActiveTab, closeEverything });
  closeActions.current = { closeActiveTab, closeEverything };

  useEffect(() => {
    const actions: Record<(typeof IDE_COMMANDS)[number], () => void> = {
      "editor.back": () => navigateBack(sessionId),
      "editor.forward": () => navigateForward(sessionId),
      "editor.selectInTree": () => revealActiveFile(sessionId),
      "editor.closeTab": () => closeActions.current.closeActiveTab(),
      "editor.closeAllTabs": () => closeActions.current.closeEverything(),
      "editor.moveTabLeft": () => moveActiveTab(sessionId, "left"),
      "editor.moveTabRight": () => moveActiveTab(sessionId, "right"),
      "editor.moveTabUp": () => moveActiveTab(sessionId, "up"),
      "editor.moveTabDown": () => moveActiveTab(sessionId, "down"),
    };
    function onKeyDown(event: KeyboardEvent) {
      const command = shortcutCommand(event, IDE_COMMANDS);
      if (!command || isForeignTextField(rootRef.current)) return;
      actions[command]();
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [sessionId, moveActiveTab, revealActiveFile, navigateBack, navigateForward]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isShortcut(event, "editor.save")) return;
      event.preventDefault();
      workspace
        .saveAll()
        .then(() => setError(null))
        .catch((reason) => setError(String(reason)))
        .finally(() => noteWorktreeChanged(sessionId));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspace, sessionId, noteWorktreeChanged]);

  // ⌃⇧C (keymap default) copies the active file's absolute path; the project tree takes it first for its own selection.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isShortcut(event, "changes.copyPath") || isForeignTextField(rootRef.current)) return;
      const { layout, activePaneId } = useIdeStore.getState().sessions[sessionId] ?? EMPTY_IDE_SESSION;
      const activePath = activePaneId ? layout.findPane(activePaneId)?.activePath : null;
      if (!activePath) return;
      event.preventDefault();
      void navigator.clipboard.writeText(`${workspace.worktreePath}/${activePath}`).catch((reason) => setError(`failed to copy the path: ${errorText(reason)}`));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspace, sessionId]);

  // The mouse's back (button 3) and forward (button 4) buttons navigate on release; neither press nor release
  // reaches the editor (no caret move) or the webview's own history.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    function onMouseButton(event: MouseEvent) {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== "mouseup") return;
      if (event.button === 3) {
        navigateBack(sessionId);
      } else {
        navigateForward(sessionId);
      }
    }
    for (const type of MOUSE_BUTTON_EVENTS) {
      root.addEventListener(type, onMouseButton, true);
    }
    return () => {
      for (const type of MOUSE_BUTTON_EVENTS) {
        root.removeEventListener(type, onMouseButton, true);
      }
    };
  }, [sessionId, navigateBack, navigateForward]);

  /**
   * Opens the sub chat about the whole file or folder beside its agent button in the project tree: the existing chat
   * with its conversation, or a new one whose agent gets the file's current content with every prompt.
   */
  const askAgent = (target: ProjectTreeTarget, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const anchor = { x: rect.right + 6, y: rect.top };
    const existingChat = selectionChatsFor(useHuntStore.getState().sessions, sessionId, target.path).find((chat) => !!chat.selection.task);
    if (existingChat) {
      subChat.open({ selection: existingChat.selection, anchor }, existingChat.sessionId);
      return;
    }
    if (target.isFolder) {
      const task = fillPrompt(projectTreeFolderPrompt.trim(), { path: target.path });
      subChat.open({ selection: { path: target.path, startLine: 1, endLine: 1, text: "", task, isFolder: true }, anchor });
      return;
    }
    commands
      .readFile(sessionId, target.path)
      .then((text) => {
        const task = fillPrompt(projectTreeFilePrompt.trim(), { path: target.path });
        subChat.open({ selection: { path: target.path, startLine: 1, endLine: Math.max(1, text.split("\n").length), text, task }, anchor });
      })
      .catch((reason) => setError(errorText(reason)));
  };

  if (!session) return null;

  const projectName = repoName(session.repoPath) || session.title;

  return (
    // Popups floating over the editor (see UsagesPopover.tsx) are portaled here, so they can be dragged over the whole panel.
    <div ref={rootRef} data-ide-root="" className="relative h-full min-h-0">
      <PersistentGroup id="hunt-ide" fillPane="editors" className="h-full min-h-0">
        <Panel id="project" defaultSize={240} minSize={160} maxSize={520} className="flex">
          <ProjectTree
            key={sessionId}
            sessionId={sessionId}
            repoPath={session.repoPath}
            projectName={projectName}
            revealRequest={ide.revealRequest}
            refreshVersion={editVersion}
            statusByPath={statusByPath}
            unsavedPaths={dirtyPaths}
            workspace={workspace}
            onOpen={(path) => openFile(sessionId, path)}
            onAskAgent={askAgent}
          />
        </Panel>
        <PaneSeparator />
        <Panel id="editors" minSize={300} className="flex flex-col">
          <DependencyBanner sessionId={sessionId} status={session.dependencies} />
          {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
          <EditorGrid
            sessionId={sessionId}
            workspace={workspace}
            ide={ide}
            dirtyPaths={dirtyPaths}
            statusByPath={statusByPath}
            onOpenSubChat={subChat.open}
            onToggleSubChat={subChat.toggle}
          />
        </Panel>
      </PersistentGroup>
      {subChat.shown ? (
        <SubChatPopover key={subChat.shown.key} parentSessionId={sessionId} request={subChat.shown.request} subSessionId={subChat.shown.subSessionId} onClose={subChat.close} />
      ) : null}
    </div>
  );
}
