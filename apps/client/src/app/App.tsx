import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useShallow } from "zustand/react/shallow";
import { useHuntStore } from "../state/store";
import { SessionSidebar } from "../sessions/SessionSidebar";
import { NewSessionView } from "../sessions/NewSessionView";
import { useShowSessionRequests } from "../sessions/showSession";
import { ChatPanel } from "../chat/ChatPanel";
import { DiffPanel } from "../diff/DiffPanel";
import { GitPanel } from "../git/GitPanel";
import { ArchitecturePanel } from "../graph/ArchitecturePanel";
import { IdePanel } from "../ide/IdePanel";
import { PullRequestPanel } from "../review/PullRequestPanel";
import { useReviewCommentTotal } from "../review/reviewComments";
import { keepDiffWindowWarm } from "../graph/diffWindows";
import { keepGuardrailsWindowWarm } from "../guardrails/openGuardrailsWindow";
import { keepSettingsWindowWarm } from "../settings/openSettingsWindow";
import { keepEditorWindowWarm, openInEditorWindow } from "../ide/editorWindows";
import { FileSearchDialog, useFileSearchShortcut } from "../ide/FileSearchDialog";
import { FindInFilesDialog, useFindInFilesShortcut } from "../ide/FindInFilesDialog";
import { EMPTY_IDE_SESSION, useIdeStore } from "../ide/ideStore";
import { allPanes } from "../ide/paneGrid";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { PreviewPanel } from "../preview/PreviewPanel";
import { isPreviewActive, isTerminalActive } from "../preview/services";
import { usePreviewStore } from "../state/preview";
import { useTerminalStore } from "../state/terminals";
import { rememberEditors, useRightTab, useSessionViewStore, type RightTab } from "../state/sessionViews";
import { LocalTerminalPanel } from "../terminal/LocalTerminalPanel";
import { useScriptRunRequests } from "../terminal/scriptRuns";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { HEADER_BAR } from "../ui/bars";
import { TAB_ACTIVE, TAB_BUTTON, TAB_INACTIVE } from "../ui/buttons";
import { restoreWindowBounds, useRememberWindowBounds } from "../ui/windowBounds";
import { useAccountsSync, useAgentPreferencesSync, useBackendEvents, usePaneStyles, useRemoteSettingsSync, useSettingsSync } from "./bootstrap";

/** How often the sidebar re-reads the gateway's listing, as often as the gateway's poller updates the agent states in it. */
const REMOTE_AGENT_POLL_MS = 30_000;

export function App() {
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const syncRemoteSessions = useHuntStore((state) => state.syncRemoteSessions);
  const loadAllChats = useHuntStore((state) => state.loadAllChats);
  const hasRemoteSessions = useHuntStore((state) => state.sessions.some((session) => session.remote));
  const activeSessionId = useHuntStore((state) => state.activeSessionId);
  const draft = useHuntStore((state) => state.draft);
  /** The active session is still being created: it has no worktree yet, so the inspector and the file search wait. */
  const isCreatingActive = useHuntStore((state) => Boolean(state.activeSessionId && state.creatingIds.includes(state.activeSessionId)));
  /** The VM the active session runs on; it adds the Preview tab and puts the Terminal tab on the VM. */
  const activeRemoteInstance = useHuntStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.remote?.vm.instance ?? null);
  /** Whether the active session's worktree exists here; a remote session adopted from its VM gets one with its first sync. */
  const hasActiveWorktree = useHuntStore((state) => state.sessions.find((session) => session.id === state.activeSessionId)?.hasLocalWorktree ?? false);
  /** Whether the active session reviews a pull request; only then does the PR Description tab show. */
  const isReviewingPullRequest = useHuntStore((state) => Boolean(state.sessions.find((session) => session.id === state.activeSessionId)?.pullRequest));
  /** Something runs on the active session's VM: a green dot marks the Preview or the Terminal tab. */
  const isPreviewBusy = usePreviewStore((state) => isPreviewActive((activeSessionId && state.previews[activeSessionId]?.status) || null));
  const isTerminalBusy = usePreviewStore((state) => {
    const preview = activeSessionId ? state.previews[activeSessionId] : undefined;
    return isTerminalActive(preview?.status ?? null, preview?.windows ?? null);
  });
  /** A script runs in the active local session's terminals: a green dot marks the Terminal tab. */
  const isLocalScriptRunning = useTerminalStore((state) =>
    Boolean(activeSessionId && state.local[activeSessionId]?.terminals.some((terminal) => terminal.script && terminal.isRunning)),
  );
  const localTerminals = useTerminalStore((state) => state.local);
  const localSessionIds = useHuntStore(useShallow((state) => state.sessions.filter((session) => !session.remote).map((session) => session.id)));
  /** The local sessions with terminals; their Terminal panels stay mounted, so switching sessions keeps the terminals running. */
  const localTerminalSessionIds = useMemo(
    () => localSessionIds.filter((sessionId) => localTerminals[sessionId]?.terminals.length),
    [localSessionIds, localTerminals],
  );
  /** The session whose tab the inspector shows and remembers; none while the start view shows. */
  const shownSessionId = draft ? null : activeSessionId;
  const storedTab = useRightTab(shownSessionId);
  /** Review comments of the pull request the shown session reviews, drafts included; the Diff tab counts them. */
  const reviewCommentCount = useReviewCommentTotal(shownSessionId);
  const setTab = useSessionViewStore((state) => state.setTab);
  const setRightTab = (tab: RightTab) => setTab(shownSessionId, tab);
  const openFile = useIdeStore((state) => state.openFile);
  const ideLayout = useIdeStore((state) => (activeSessionId ? state.sessions[activeSessionId]?.layout : null) ?? EMPTY_IDE_SESSION.layout);
  const openPaths = useMemo(() => [...new Set(allPanes(ideLayout).flatMap((pane) => pane.tabs))], [ideLayout]);
  const [isFileSearchOpen, setIsFileSearchOpen] = useState(false);
  /** Find in Files is open, starting with the text that was selected in the editor (`null`: the last query). */
  const [findInFiles, setFindInFiles] = useState<{ initialText: string | null } | null>(null);
  const hasLocalWorktree = !isCreatingActive && hasActiveWorktree;
  const canSearchFiles = Boolean(activeSessionId) && !draft && hasLocalWorktree;
  /** A local session has no preview, a session without a pull request no description; they show the diff instead. */
  const rightTab = (!activeRemoteInstance && storedTab === "preview") || (!isReviewingPullRequest && storedTab === "pullRequest") ? "diff" : storedTab;
  /** The local session whose Terminal panel shows; its panel mounts at the first show and stays while it has terminals. */
  const shownLocalTerminalId = activeSessionId && !draft && !isCreatingActive && !activeRemoteInstance && rightTab === "terminal" ? activeSessionId : null;
  const localTerminalPanelIds = shownLocalTerminalId && !localTerminalSessionIds.includes(shownLocalTerminalId) ? [...localTerminalSessionIds, shownLocalTerminalId] : localTerminalSessionIds;

  // ⌘P / double shift: "Go to File" for the active session's worktree.
  useFileSearchShortcut(() => {
    if (canSearchFiles) {
      setIsFileSearchOpen(true);
    }
  });

  // ⇧⌘F: "Find in Files" for the active session's worktree.
  useFindInFilesShortcut((initialText) => {
    if (canSearchFiles) {
      setFindInFiles({ initialText });
    }
  });

  usePaneStyles();
  useSettingsSync();
  useAgentPreferencesSync();
  useRemoteSettingsSync();
  useAccountsSync();
  useBackendEvents();
  useShowSessionRequests();
  useScriptRunRequests();
  useRememberWindowBounds("main");

  // Each session's editor shows the tabs, carets and scroll positions it was left with, also after a restart.
  useEffect(() => rememberEditors(), []);

  // The window starts hidden (see tauri.conf.json) and appears once it has its remembered bounds; on first use it is
  // 1600 px wide (or as wide as the screen) and as tall as the screen.
  useEffect(() => {
    void restoreWindowBounds("main", { fillScreenByDefault: true }).finally(() => getCurrentWindow().show());
  }, []);

  // Every session's chat loads at start, so the sidebar shows what each agent is up to before a session is opened; the
  // remote sessions take the agent state the gateway recorded; the start view's list adopts further session VMs.
  useEffect(() => {
    void refreshSessions().then(loadAllChats);
    void syncRemoteSessions();
  }, [refreshSessions, syncRemoteSessions, loadAllChats]);

  // The agent states the gateway records change while Hunt runs; the marks of the remote sessions follow them.
  useEffect(() => {
    if (!hasRemoteSessions) return;
    const timer = window.setInterval(() => void syncRemoteSessions(), REMOTE_AGENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasRemoteSessions, syncRemoteSessions]);

  // The push targets are the upstreams of the sessions' branches, which git in a terminal may change; they are read
  // again whenever the window comes back to the front.
  useEffect(() => {
    const refresh = () => void refreshSessions();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshSessions]);

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
              <TabButton isActive={rightTab === "diff"} onClick={() => setRightTab("diff")} label="Diff" commentCount={reviewCommentCount} />
              <TabButton isActive={rightTab === "git"} onClick={() => setRightTab("git")} label="Git" />
              <TabButton isActive={rightTab === "editor"} onClick={() => setRightTab("editor")} label="Editor" />
              <TabButton isActive={rightTab === "graph"} onClick={() => setRightTab("graph")} label="Architecture" />
              {isReviewingPullRequest ? (
                <TabButton isActive={rightTab === "pullRequest"} onClick={() => setRightTab("pullRequest")} label="PR Description" />
              ) : null}
              {activeRemoteInstance ? (
                <TabButton isActive={rightTab === "preview"} onClick={() => setRightTab("preview")} label="Preview" hasActivity={isPreviewBusy} />
              ) : null}
              <TabButton
                isActive={rightTab === "terminal"}
                onClick={() => setRightTab("terminal")}
                label="Terminal"
                hasActivity={activeRemoteInstance ? isTerminalBusy : isLocalScriptRunning}
              />
            </nav>
            <div className="min-h-0 flex-1">
              {!activeSessionId || draft || isCreatingActive ? null : (
                <>
                  {/* The panels are siblings of one fragment, so their keys carry the tab as well as the session: a shared key would keep React from removing a panel that another tab replaced. */}
                  {rightTab === "preview" || rightTab === "terminal" ? null : activeRemoteInstance && !hasActiveWorktree ? (
                    <NoLocalWorktree sessionId={activeSessionId} />
                  ) : rightTab === "diff" ? (
                    <DiffPanel key={`diff:${activeSessionId}`} sessionId={activeSessionId} />
                  ) : rightTab === "git" ? (
                    <GitPanel key={`git:${activeSessionId}`} sessionId={activeSessionId} />
                  ) : rightTab === "editor" ? (
                    <IdePanel sessionId={activeSessionId} />
                  ) : rightTab === "pullRequest" ? (
                    <PullRequestPanel key={`pullRequest:${activeSessionId}`} sessionId={activeSessionId} />
                  ) : (
                    <ArchitecturePanel key={`graph:${activeSessionId}`} sessionId={activeSessionId} />
                  )}
                  {activeRemoteInstance && rightTab === "preview" ? <PreviewPanel key={`preview:${activeSessionId}`} sessionId={activeSessionId} /> : null}
                  {/* The terminal stays mounted while another tab shows, so switching tabs keeps its connection. */}
                  {activeRemoteInstance ? <TerminalPanel key={`terminal:${activeSessionId}`} sessionId={activeSessionId} isVisible={rightTab === "terminal"} /> : null}
                </>
              )}
              {localTerminalPanelIds.map((sessionId) => (
                <LocalTerminalPanel key={`local-terminal:${sessionId}`} sessionId={sessionId} isVisible={sessionId === shownLocalTerminalId} />
              ))}
            </div>
          </aside>
        </Panel>
      </PersistentGroup>
      {isFileSearchOpen && canSearchFiles && activeSessionId ? (
        <FileSearchDialog
          sessionId={activeSessionId}
          openPaths={openPaths}
          onClose={() => setIsFileSearchOpen(false)}
          onOpen={(path, line, column, inRightSplit) => {
            if (rightTab === "editor") {
              openFile(activeSessionId, path, { line, column, inRightSplit });
            } else {
              void openInEditorWindow(activeSessionId, { path, line, column, inRightSplit });
            }
          }}
        />
      ) : null}
      {findInFiles && canSearchFiles && activeSessionId ? (
        <FindInFilesDialog
          sessionId={activeSessionId}
          initialText={findInFiles.initialText}
          onClose={() => setFindInFiles(null)}
          onOpen={(path, line, column, inRightSplit) => {
            if (rightTab === "editor") {
              openFile(activeSessionId, path, { line, column, inRightSplit });
            } else {
              void openInEditorWindow(activeSessionId, { path, line, column, inRightSplit });
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

/**
 * A tab of the inspector; `hasActivity` adds a small green dot after the label, a `commentCount` above 0 a blue
 * badge with that count of review comments, raised to the label's top right corner.
 */
function TabButton({
  isActive,
  onClick,
  label,
  hasActivity = false,
  commentCount = 0,
}: {
  isActive: boolean;
  onClick: () => void;
  label: string;
  hasActivity?: boolean;
  commentCount?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${TAB_BUTTON} gap-1.5 ${isActive ? TAB_ACTIVE : TAB_INACTIVE}`}
    >
      {label}
      {hasActivity ? <span className="size-1.5 shrink-0 rounded-full bg-green-400" title="Something runs on the VM" /> : null}
      {commentCount ? <CountBadge count={commentCount} label={`${commentCount} review ${commentCount === 1 ? "comment" : "comments"}`} /> : null}
    </button>
  );
}

const BADGE_HEIGHT = 16;
/** Extra width per digit beyond the first, so `12` stretches the circle into a pill. */
const BADGE_DIGIT_WIDTH = 6;
/** Baseline that centres digits: half the height plus half their height (~0.7 em at 10px). */
const BADGE_BASELINE = BADGE_HEIGHT / 2 + 3.5;

/**
 * A count in a blue circle, raised like a superscript; more than one digit stretch it into a pill. Drawn as one SVG
 * so circle and digits share the same sub-pixel offset; HTML text snaps its baseline to whole pixels and drifts.
 */
function CountBadge({ count, label }: { count: number; label: string }) {
  const text = count > 99 ? "99+" : String(count);
  const width = BADGE_HEIGHT + (text.length - 1) * BADGE_DIGIT_WIDTH;
  return (
    <svg width={width} height={BADGE_HEIGHT} viewBox={`0 0 ${width} ${BADGE_HEIGHT}`} className="relative -top-1.5 -ml-0.5 shrink-0" role="img" aria-label={label}>
      <title>{label}</title>
      <rect width={width} height={BADGE_HEIGHT} rx={BADGE_HEIGHT / 2} className="fill-blue-600" />
      <text x={width / 2} y={BADGE_BASELINE} textAnchor="middle" className="fill-white text-[10px] font-semibold">
        {text}
      </text>
    </svg>
  );
}
