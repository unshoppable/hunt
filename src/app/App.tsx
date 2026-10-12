import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useHuntStore } from "../state/store";
import { SessionSidebar } from "../sessions/SessionSidebar";
import { NewSessionView } from "../sessions/NewSessionView";
import { ChatPanel } from "../chat/ChatPanel";
import { DiffPanel } from "../diff/DiffPanel";
import { GraphPanel } from "../graph/GraphPanel";
import { IdePanel } from "../ide/IdePanel";
import { PullRequestPanel } from "../review/PullRequestPanel";
import { keepDiffWindowWarm } from "../graph/diffWindows";
import { keepGuardrailsWindowWarm } from "../guardrails/openGuardrailsWindow";
import { keepSettingsWindowWarm } from "../settings/openSettingsWindow";
import { keepEditorWindowWarm, openInEditorWindow } from "../ide/editorWindows";
import { FileSearchDialog, useFileSearchShortcut } from "../ide/FileSearchDialog";
import { EMPTY_IDE_SESSION, useIdeStore } from "../ide/ideStore";
import { allPanes } from "../ide/paneGrid";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { HEADER_BAR } from "../ui/bars";
import { TAB_ACTIVE, TAB_BUTTON, TAB_INACTIVE } from "../ui/buttons";
import { restoreWindowBounds, useRememberWindowBounds } from "../ui/windowBounds";
import { useAccountsSync, useAgentPreferencesSync, useBackendEvents, usePaneStyles, useSettingsSync } from "./bootstrap";

export function App() {
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const activeSessionId = useHuntStore((state) => state.activeSessionId);
  const draft = useHuntStore((state) => state.draft);
  /** The active session is still being created: it has no worktree yet, so the inspector and the file search wait. */
  const isCreatingActive = useHuntStore((state) => Boolean(state.activeSessionId && state.creatingIds.includes(state.activeSessionId)));
  /** The VM the active session runs on; its worktree is not local, so the inspector, the file search and the editor wait. */
  const activeRemoteInstance = useHuntStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.remote?.vm.instance ?? null);
  const rightTab = useHuntStore((state) => state.rightTab);
  const setRightTab = useHuntStore((state) => state.setRightTab);
  const openFile = useIdeStore((state) => state.openFile);
  const ideLayout = useIdeStore((state) => (activeSessionId ? state.sessions[activeSessionId]?.layout : null) ?? EMPTY_IDE_SESSION.layout);
  const openPaths = useMemo(() => [...new Set(allPanes(ideLayout).flatMap((pane) => pane.tabs))], [ideLayout]);
  const [isFileSearchOpen, setIsFileSearchOpen] = useState(false);
  const canSearchFiles = Boolean(activeSessionId) && !draft && !isCreatingActive && !activeRemoteInstance;

  // ⌘P / double shift: "Go to File" for the active session's worktree.
  useFileSearchShortcut(() => {
    if (canSearchFiles) {
      setIsFileSearchOpen(true);
    }
  });

  usePaneStyles();
  useSettingsSync();
  useAgentPreferencesSync();
  useAccountsSync();
  useBackendEvents();
  useRememberWindowBounds("main");

  // The window starts hidden (see tauri.conf.json) and appears once it has its remembered bounds; on first use it is
  // 1600 px wide (or as wide as the screen) and as tall as the screen.
  useEffect(() => {
    void restoreWindowBounds("main", { fillScreenByDefault: true }).finally(() => getCurrentWindow().show());
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // The active session's editor window boots hidden, so ⌘click in the diff only has to show it (see ide/editorWindows.ts).
  const hasLocalWorktree = !isCreatingActive && !activeRemoteInstance;
  useEffect(() => keepEditorWindowWarm(hasLocalWorktree ? activeSessionId : null), [activeSessionId, hasLocalWorktree]);

  // Likewise the guardrails window, so the "Guardrails" button in the chat header only has to show it.
  useEffect(() => keepGuardrailsWindowWarm(hasLocalWorktree ? activeSessionId : null), [activeSessionId, hasLocalWorktree]);

  // A diff window boots hidden ahead of time, so a click on a changed file in the diagram only has to fill and show it (see graph/diffWindows.ts).
  useEffect(() => keepDiffWindowWarm(), []);

  // The settings window boots hidden too, so ⌘, and the gear button only have to show it (see settings/openSettingsWindow.ts).
  useEffect(() => keepSettingsWindowWarm(), []);

  return (
    <>
      <PersistentGroup id="hunt-main" className="h-full">
        <Panel id="sessions" defaultSize={200} minSize={180} maxSize={480} className="flex">
          <SessionSidebar />
        </Panel>
        <PaneSeparator />
        <Panel id="chat" minSize={360} className="flex">
          <section className="flex min-w-0 flex-1 flex-col">
            {/* Without an open session the chat pane shows the start view, so the first prompt or the choice of a repository creates a session right away. */}
            {activeSessionId && !draft ? (
              <ChatPanel sessionId={activeSessionId} />
            ) : (
              <NewSessionView key={draft?.parentId ?? ""} parentId={draft?.parentId ?? null} initialError={draft?.error} initialPrompt={draft?.prompt} />
            )}
          </section>
        </Panel>
        <PaneSeparator />
        <Panel id="inspector" defaultSize="62%" minSize={320} className="flex">
          <aside className="flex min-w-0 flex-1 flex-col bg-(--surface-inspector)">
            <nav data-tauri-drag-region="" className={`${HEADER_BAR} gap-1 border-b border-(--line) px-2`}>
              <TabButton isActive={rightTab === "diff"} onClick={() => setRightTab("diff")} label="Diff" />
              <TabButton isActive={rightTab === "editor"} onClick={() => setRightTab("editor")} label="Editor" />
              <TabButton isActive={rightTab === "graph"} onClick={() => setRightTab("graph")} label="Dependency Graph" />
              <TabButton isActive={rightTab === "pullRequest"} onClick={() => setRightTab("pullRequest")} label="PR Description" />
            </nav>
            <div className="min-h-0 flex-1">
              {!activeSessionId || draft || isCreatingActive ? null : activeRemoteInstance ? (
                <div className="flex h-full items-center justify-center px-8 text-center text-sm text-neutral-500">
                  This session runs on the VM {activeRemoteInstance}. Diff, editor, graph and review work again once you bring it back.
                </div>
              ) : rightTab === "diff" ? (
                <DiffPanel key={activeSessionId} sessionId={activeSessionId} />
              ) : rightTab === "editor" ? (
                <IdePanel sessionId={activeSessionId} />
              ) : rightTab === "pullRequest" ? (
                <PullRequestPanel key={activeSessionId} sessionId={activeSessionId} />
              ) : (
                <GraphPanel key={activeSessionId} sessionId={activeSessionId} />
              )}
            </div>
          </aside>
        </Panel>
      </PersistentGroup>
      {isFileSearchOpen && canSearchFiles && activeSessionId ? (
        <FileSearchDialog
          sessionId={activeSessionId}
          openPaths={openPaths}
          onClose={() => setIsFileSearchOpen(false)}
          onOpen={(path, line, inRightSplit) => {
            if (rightTab === "editor") {
              openFile(activeSessionId, path, { line: line ?? undefined, inRightSplit });
            } else {
              void openInEditorWindow(activeSessionId, { path, line: line ?? undefined, inRightSplit });
            }
          }}
        />
      ) : null}
    </>
  );
}

function TabButton({ isActive, onClick, label }: { isActive: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${TAB_BUTTON} ${isActive ? TAB_ACTIVE : TAB_INACTIVE}`}
    >
      {label}
    </button>
  );
}
