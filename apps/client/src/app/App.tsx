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
import { PreviewPanel } from "../preview/PreviewPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { HEADER_BAR } from "../ui/bars";
import { TAB_ACTIVE, TAB_BUTTON, TAB_INACTIVE } from "../ui/buttons";
import { restoreWindowBounds, useRememberWindowBounds } from "../ui/windowBounds";
import { useAccountsSync, useAgentPreferencesSync, useBackendEvents, usePaneStyles, useRemoteSettingsSync, useSettingsSync } from "./bootstrap";

export function App() {
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const syncRemoteSessions = useHuntStore((state) => state.syncRemoteSessions);
  const activeSessionId = useHuntStore((state) => state.activeSessionId);
  const draft = useHuntStore((state) => state.draft);
  /** The active session is still being created: it has no worktree yet, so the inspector and the file search wait. */
  const isCreatingActive = useHuntStore((state) => Boolean(state.activeSessionId && state.creatingIds.includes(state.activeSessionId)));
  /** The VM the active session runs on; it adds the Preview and Terminal tabs. */
  const activeRemoteInstance = useHuntStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.remote?.vm.instance ?? null);
  /** Whether the active session's worktree exists here; a remote session adopted from its VM gets one with its first sync. */
  const hasActiveWorktree = useHuntStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.hasLocalWorktree ?? false);
  const storedTab = useHuntStore((state) => state.rightTab);
  const setRightTab = useHuntStore((state) => state.setRightTab);
  const openFile = useIdeStore((state) => state.openFile);
  const ideLayout = useIdeStore((state) => (activeSessionId ? state.sessions[activeSessionId]?.layout : null) ?? EMPTY_IDE_SESSION.layout);
  const openPaths = useMemo(() => [...new Set(allPanes(ideLayout).flatMap((pane) => pane.tabs))], [ideLayout]);
  const [isFileSearchOpen, setIsFileSearchOpen] = useState(false);
  const hasLocalWorktree = !isCreatingActive && hasActiveWorktree;
  const canSearchFiles = Boolean(activeSessionId) && !draft && hasLocalWorktree;
  /** A local session has no preview or terminal; it shows the diff instead. */
  const rightTab = !activeRemoteInstance && (storedTab === "preview" || storedTab === "terminal") ? "diff" : storedTab;

  // ⌘P / double shift: "Go to File" for the active session's worktree.
  useFileSearchShortcut(() => {
    if (canSearchFiles) {
      setIsFileSearchOpen(true);
    }
  });

  usePaneStyles();
  useSettingsSync();
  useAgentPreferencesSync();
  useRemoteSettingsSync();
  useAccountsSync();
  useBackendEvents();
  useRememberWindowBounds("main");

  // The window starts hidden (see tauri.conf.json) and appears once it has its remembered bounds; on first use it is
  // 1600 px wide (or as wide as the screen) and as tall as the screen.
  useEffect(() => {
    void restoreWindowBounds("main", { fillScreenByDefault: true }).finally(() => getCurrentWindow().show());
  }, []);

  // The remote sessions take the agent state the gateway recorded; the start view's list adopts further session VMs.
  useEffect(() => {
    void refreshSessions();
    void syncRemoteSessions();
  }, [refreshSessions, syncRemoteSessions]);

  // The active session's editor window boots hidden, so ⌘click in the diff only has to show it (see ide/editorWindows.ts).
  useEffect(() => keepEditorWindowWarm(hasLocalWorktree ? activeSessionId : null), [activeSessionId, hasLocalWorktree]);

  // Likewise the guardrails window, so the "Guardrails" button in the chat header (shown for local sessions) only has to show it.
  const hasGuardrails = hasLocalWorktree && !activeRemoteInstance;
  useEffect(() => keepGuardrailsWindowWarm(hasGuardrails ? activeSessionId : null), [activeSessionId, hasGuardrails]);

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
              {activeRemoteInstance ? (
                <>
                  <TabButton isActive={rightTab === "preview"} onClick={() => setRightTab("preview")} label="Preview" />
                  <TabButton isActive={rightTab === "terminal"} onClick={() => setRightTab("terminal")} label="Terminal" />
                </>
              ) : null}
            </nav>
            <div className="min-h-0 flex-1">
              {!activeSessionId || draft || isCreatingActive ? null : (
                <>
                  {/* The panels are siblings of one fragment, so their keys carry the tab as well as the session: a shared key would keep React from removing a panel that another tab replaced. */}
                  {rightTab === "preview" || rightTab === "terminal" ? null : activeRemoteInstance && !hasActiveWorktree ? (
                    <NoLocalWorktree sessionId={activeSessionId} />
                  ) : rightTab === "diff" ? (
                    <DiffPanel key={`diff:${activeSessionId}`} sessionId={activeSessionId} />
                  ) : rightTab === "editor" ? (
                    <IdePanel sessionId={activeSessionId} />
                  ) : rightTab === "pullRequest" ? (
                    <PullRequestPanel key={`pullRequest:${activeSessionId}`} sessionId={activeSessionId} />
                  ) : (
                    <GraphPanel key={`graph:${activeSessionId}`} sessionId={activeSessionId} />
                  )}
                  {activeRemoteInstance && rightTab === "preview" ? <PreviewPanel key={`preview:${activeSessionId}`} sessionId={activeSessionId} /> : null}
                  {/* The terminal stays mounted while another tab shows, so switching tabs keeps its connection. */}
                  {activeRemoteInstance ? <TerminalPanel key={`terminal:${activeSessionId}`} sessionId={activeSessionId} isVisible={rightTab === "terminal"} /> : null}
                </>
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

/** What the worktree tabs of a remote session show until Hunt copied its files here. */
function NoLocalWorktree({ sessionId }: { sessionId: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const message =
    session?.remote && !session.repoPath
      ? `There is no local checkout of ${session.remote.repo}. Start a session in one, then refresh the remote sessions in the sidebar; ` +
        "Hunt then copies this session's files here."
      : "Hunt copies the session's files here once it reached the VM; your next prompt starts the VM.";
  return <div className="flex h-full items-center justify-center px-8 text-center text-[14px] text-neutral-500">{message}</div>;
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
