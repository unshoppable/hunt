import { useEffect, useMemo, useRef } from "react";
import { SubChatPopover, useSubChatPopover } from "../chat/SubChatPopover";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { useHuntStore } from "../state/store";
import { repoName } from "../ui/path";
import { shortcutCommand } from "../ui/shortcuts";
import { DependencyBanner } from "./DependencyBanner";
import { workspaceFor } from "./documents";
import { EditorGrid } from "./EditorGrid";
import { EMPTY_IDE_SESSION, useIdeSession, useIdeStore } from "./ideStore";
import { allPanes, findPane, panesShowing } from "./paneGrid";
import { ProjectTree } from "./ProjectTree";

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
 * ⌘W closes the active tab (and its pane when it was the last one) or calls `onCloseEmpty` when no tab is open,
 * ⇧⌘W closes every tab, ⇧⌘2 selects the active file in the project tree. The tree selection follows ⇧⌘2 only,
 * never the active pane. ⌘[ / ⌘] (also ⌥⌘← / ⌥⌘→) and the mouse's back / forward buttons step through the
 * navigation history.
 */
export function IdePanel({ sessionId, onCloseEmpty }: { sessionId: string; onCloseEmpty?: () => void }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const ide = useIdeSession(sessionId);
  const openFile = useIdeStore((state) => state.openFile);
  const setDirty = useIdeStore((state) => state.setDirty);
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

  useEffect(() => workspace.onDirtyChange((path, isDirty) => setDirty(sessionId, path, isDirty)).dispose, [workspace, sessionId, setDirty]);

  const openPaths = useMemo(() => [...new Set(allPanes(ide.layout).flatMap((pane) => pane.tabs))], [ide.layout]);
  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;
  useEffect(() => {
    void workspace.reloadFromDisk(openPathsRef.current);
  }, [workspace, editVersion]);

  const closeActiveTab = async () => {
    const { layout, activePaneId } = useIdeStore.getState().sessions[sessionId] ?? EMPTY_IDE_SESSION;
    const pane = activePaneId ? findPane(layout, activePaneId) : null;
    if (!pane?.activePath) {
      onCloseEmpty?.();
      return;
    }
    const isLastView = panesShowing(layout, pane.activePath).length <= 1;
    if (isLastView && !(await workspace.discardIfConfirmed([pane.activePath]))) return;
    closeTab(sessionId, pane.id, pane.activePath);
  };

  const closeEverything = async () => {
    const { layout } = useIdeStore.getState().sessions[sessionId] ?? EMPTY_IDE_SESSION;
    const paths = [...new Set(allPanes(layout).flatMap((pane) => pane.tabs))];
    if (!paths.length || !(await workspace.discardIfConfirmed(paths))) return;
    closeAllTabs(sessionId);
  };
  const closeActions = useRef({ closeActiveTab, closeEverything });
  closeActions.current = { closeActiveTab, closeEverything };

  useEffect(() => {
    const actions: Record<(typeof IDE_COMMANDS)[number], () => void> = {
      "editor.back": () => navigateBack(sessionId),
      "editor.forward": () => navigateForward(sessionId),
      "editor.selectInTree": () => revealActiveFile(sessionId),
      "editor.closeTab": () => void closeActions.current.closeActiveTab(),
      "editor.closeAllTabs": () => void closeActions.current.closeEverything(),
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

  if (!session) return null;

  const projectName = repoName(session.repoPath) || session.title;

  return (
    // Popups floating over the editor (see UsagesPopover.tsx) are portaled here, so they can be dragged over the whole panel.
    <div ref={rootRef} data-ide-root="" className="relative h-full min-h-0">
      <PersistentGroup id="hunt-ide" className="h-full min-h-0">
        <Panel id="project" defaultSize={240} minSize={160} maxSize={520} className="flex">
          <ProjectTree
            key={sessionId}
            sessionId={sessionId}
            repoPath={session.repoPath}
            projectName={projectName}
            revealRequest={ide.revealRequest}
            refreshVersion={editVersion}
            onOpen={(path) => openFile(sessionId, path)}
          />
        </Panel>
        <PaneSeparator />
        <Panel id="editors" minSize={300} className="flex flex-col">
          <DependencyBanner sessionId={sessionId} status={session.dependencies} />
          <EditorGrid sessionId={sessionId} workspace={workspace} ide={ide} onOpenSubChat={subChat.open} onToggleSubChat={subChat.toggle} />
        </Panel>
      </PersistentGroup>
      {subChat.shown ? (
        <SubChatPopover key={subChat.shown.key} parentSessionId={sessionId} request={subChat.shown.request} subSessionId={subChat.shown.subSessionId} onClose={subChat.close} />
      ) : null}
    </div>
  );
}
