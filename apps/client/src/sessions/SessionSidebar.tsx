import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { commands } from "../ipc/commands";
import type { SessionEnding, SessionView } from "../ipc/types";
import { checkForUpdate } from "../ipc/updater";
import { useHuntStore } from "../state/store";
import { configuredVmSettings, useSettingsStore } from "../state/settings";
import { accountOptions, LOCAL_LOGIN, useAccountsStore } from "../state/accounts";
import { openSettingsWindow } from "../settings/openSettingsWindow";
import { useFileIconUrl } from "../diff/fileIcons";
import { cycleSessionId, filterSessionRows, groupSessions, sessionMarks, sessionReference, sessionSubtitle, sidebarTitle, type ReferenceTone } from "./sessionLabels";
import { SessionMark } from "./SessionMark";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { StaleRemoteDialog } from "./StaleRemoteDialog";
import { remoteOriginLabel, remoteOriginTitle, removeFromSidebarQuestion } from "./remoteOrigin";
import { PlanUsageBar } from "./PlanUsageBar";
import { PANE_TOGGLE_ROW } from "../layout/ResizablePanes";
import { HEADER_BAR } from "../ui/bars";
import { ICON_BUTTON, PRIMARY_BUTTON_XS } from "../ui/buttons";
import { Dropdown } from "../ui/Dropdown";
import { SearchField } from "../ui/SearchField";
import { BranchIcon, CloseIcon, CloudSyncIcon, GitHubIcon, PlusIcon, PullRequestIcon, PushIcon, RepoIcon, Spinner, TicketIcon } from "../ui/icons";
import { remoteOf } from "../chat/remoteSession";
import { GitMenu, type GitMenuEntry } from "../git/GitMenu";
import { PushTargetDialog } from "../git/BranchDialogs";
import { originBranchName } from "../git/branchActions";
import { useLoad } from "../ui/useLoad";
import { isShortcut, shortcutCommand, useShortcutLabel, withShortcut } from "../ui/shortcuts";

/** The keymap commands that step through the visible sessions. */
const SESSION_CYCLE_COMMANDS = ["session.next", "session.previous"] as const;

/** The session list; `collapseToggle` sits beside the search field. */
export function SessionSidebar({ collapseToggle }: { collapseToggle: ReactNode }) {
  const fileIconUrl = useFileIconUrl();
  const sessions = useHuntStore((state) => state.sessions);
  const activeSessionId = useHuntStore((state) => state.activeSessionId);
  const selectSession = useHuntStore((state) => state.selectSession);
  const closeSession = useHuntStore((state) => state.closeSession);
  const startDraft = useHuntStore((state) => state.startDraft);
  const cancelPrompt = useHuntStore((state) => state.cancelPrompt);
  const chats = useHuntStore((state) => state.chats);
  const creatingIds = useHuntStore((state) => state.creatingIds);
  const remoteSync = useHuntStore((state) => state.remoteSync);
  /** Set while a refresh the user asked for runs; the periodic refresh of the remote sessions shows nothing. */
  const [isRefreshingRemote, setIsRefreshingRemote] = useState(false);
  const syncRemoteSessions = useHuntStore((state) => state.syncRemoteSessions);
  const canSyncRemote = useSettingsStore((state) => configuredVmSettings(state.remote) !== null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => filterSessionRows(groupSessions(sessions), query), [sessions, query]);
  const marks = useMemo(() => sessionMarks(sessions), [sessions]);
  const pullRequestStates = useHuntStore((state) => state.pullRequestStates);
  const refreshPullRequestStates = useHuntStore((state) => state.refreshPullRequestStates);
  // The badges of reviewed pull requests follow their state on GitHub: fetched when the set of reviewing sessions
  // changes and whenever the window comes back to the front.
  const reviewingIds = sessions.filter((session) => session.pullRequest && !session.parentId).map((session) => session.id).join(",");
  useEffect(() => {
    if (!reviewingIds) return;
    const refresh = () => void refreshPullRequestStates();
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [reviewingIds, refreshPullRequestStates]);
  const listRef = useRef<HTMLUListElement>(null);
  // A new session joins the end of the list, so the row of a newly active session is scrolled into view.
  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [activeSessionId]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /** The session the confirmation dialog is open for, with the question it shows. */
  const [pendingDelete, setPendingDelete] = useState<{ sessionId: string; question: string; ending: SessionEnding } | null>(null);
  /** Version of the newer Hunt the release feed offers; shown as a dot on the gear. */
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const settingsShortcut = useShortcutLabel("app.openSettings");
  /** The session whose context menu is open, at the click position. */
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  /** The session the push target dialog is open for. */
  const [retargetingId, setRetargetingId] = useState<string | null>(null);
  /** Why the last context menu action failed; shown above the list until dismissed. */
  const [menuError, setMenuError] = useState<string | null>(null);
  const menuSession = menu ? (sessions.find((session) => session.id === menu.sessionId) ?? null) : null;
  const retargeting = retargetingId ? (sessions.find((session) => session.id === retargetingId) ?? null) : null;

  // One quiet check per launch; a failed check shows nothing here, the Updates settings page reports it. Dev builds
  // carry no release version, so they do not check.
  useLoad(
    checkForUpdate,
    { onValue: (update) => setAvailableVersion(update?.version ?? null), onError: () => setAvailableVersion(null) },
    [],
    { isEnabled: !import.meta.env.DEV },
  );

  /**
   * Takes the session out of the sidebar, after confirmation unless the user turned the dialog off: a local session
   * is deleted (a top-level one takes its sub sessions and worktree along); a remote session is only forgotten here,
   * its VM keeps running and the list of remote sessions brings it back. The trash button under the prompt box
   * deletes a remote session with its VM.
   */
  const removeSession = (session: SessionView, isSubChat: boolean) => {
    const ending = session.remote && !isSubChat ? "forget" : "delete";
    if (!useSettingsStore.getState().confirmSessionDelete) {
      void closeSession(session.id, ending);
      return;
    }
    const question =
      ending === "forget"
        ? removeFromSidebarQuestion(session)
        : isSubChat
          ? `Delete sub session "${session.title}"?`
          : session.workspace === "checkout"
            ? `Delete session "${session.title}" and its sub sessions? The repository's checkout keeps its changes.`
            : `Delete session "${session.title}", its sub sessions and its worktree?`;
    setPendingDelete({ sessionId: session.id, question, ending });
  };
  const removeSessionRef = useRef(removeSession);
  removeSessionRef.current = removeSession;

  // ⌘, (keymap default) opens the settings like a native macOS app.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isShortcut(event, "app.openSettings")) return;
      event.preventDefault();
      void openSettingsWindow();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌃⇥ (keymap default) selects the next session in the visible list, ⌃⇧⇥ the previous one, wrapping at both ends.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const command = event.defaultPrevented ? null : shortcutCommand(event, SESSION_CYCLE_COMMANDS);
      if (!command) return;
      event.preventDefault();
      const { activeSessionId, draft, selectSession } = useHuntStore.getState();
      const id = cycleSessionId(rowsRef.current, draft ? null : activeSessionId, command === "session.previous" ? -1 : 1);
      if (id) void selectSession(id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘W (keymap default) while the focus is inside the sidebar removes the selected session. Runs in the capture phase
  // and stops the event so the editor's own binding of the same key (close tab) does not fire for the same key press.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isShortcut(event, "session.remove")) return;
      const active = document.activeElement;
      if (!active || !rootRef.current?.contains(active)) return;
      const { activeSessionId, sessions, draft } = useHuntStore.getState();
      const row = draft ? null : groupSessions(sessions).find(({ session }) => session.id === activeSessionId);
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      removeSessionRef.current(row.session, row.isSubChat);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1 flex-col bg-(--sidebar-bg)">
      {/* The macOS traffic lights sit in this row (see tauri.conf.json), so it starts further right and drags the window. */}
      <div data-tauri-drag-region="" className={`${HEADER_BAR} justify-between pr-3 pl-23`}>
        <AccountSwitcher />
        <span data-tauri-drag-region="" className="flex shrink-0 items-center gap-1">
          {canSyncRemote ? (
            <button
              type="button"
              onClick={() => {
                setIsRefreshingRemote(true);
                void syncRemoteSessions().finally(() => setIsRefreshingRemote(false));
              }}
              disabled={isRefreshingRemote}
              className={`${ICON_BUTTON} ${remoteSync.error ? "text-red-300" : ""}`}
              title={
                remoteSync.error
                  ? `Refresh remote sessions · the last refresh failed: ${remoteSync.error}`
                  : "Refresh remote sessions: bring the state of the remote sessions up to date from the gateway"
              }
              aria-label="Refresh remote sessions"
            >
              {isRefreshingRemote ? <Spinner className="size-4" /> : <CloudSyncIcon />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void openSettingsWindow(availableVersion ? "updates" : undefined)}
            className={`${ICON_BUTTON} relative`}
            title={withShortcut(availableVersion ? `Settings · Hunt ${availableVersion} is available` : "Settings", settingsShortcut)}
            aria-label={availableVersion ? `Settings, Hunt ${availableVersion} is available` : "Settings"}
          >
            <GearIcon />
            {availableVersion ? <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-blue-500 ring-2 ring-(--sidebar-bg)" /> : null}
          </button>
          <button
            type="button"
            onClick={() => startDraft()}
            className={PRIMARY_BUTTON_XS}
          >
            <PlusIcon className="size-3" />
            New
          </button>
        </span>
      </div>
      <div className={`${PANE_TOGGLE_ROW} mx-2 mb-2 gap-2`}>
        <SearchField value={query} onChange={setQuery} ariaLabel="Search sessions" className="min-w-0 flex-1" />
        {collapseToggle}
      </div>
      {remoteSync.error ? (
        <p className="mx-2 mb-2 rounded-md bg-red-400/10 px-2.5 py-1.5 text-[13px] break-words text-red-300">
          Refreshing the remote sessions failed: {remoteSync.error}
        </p>
      ) : null}
      {menuError ? (
        <p className="mx-2 mb-2 flex items-start gap-2 rounded-md bg-red-400/10 px-2.5 py-1.5 text-[13px] break-words text-red-300">
          <span className="min-w-0 flex-1">{menuError}</span>
          <button type="button" onClick={() => setMenuError(null)} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-white/10 hover:text-white">
            <CloseIcon className="size-3" />
          </button>
        </p>
      ) : null}
      <ul ref={listRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2 font-(family-name:--sidebar-font-family) text-(length:--sidebar-font-size) leading-(--sidebar-line-height)">
        {query && rows.length === 0 ? <li className="px-2.5 py-1.5 text-[0.875em] text-neutral-500">No sessions match “{query}”</li> : null}
        {rows.map(({ session, isSubChat, repository }, index) => {
          const isActive = session.id === activeSessionId;
          const isBusy = chats[session.id]?.isBusy ?? false;
          // A session the backend still creates has no worktree or agent yet: nothing can be started in or done to it.
          const isCreating = creatingIds.includes(session.id);
          const reference = sessionReference(session, pullRequestStates[session.id] ?? null);
          // The repository heads its group of sessions: a heading before the first row of every repository.
          const startsGroup = !isSubChat && (index === 0 || rows[index - 1].repository !== repository);
          return (
            <Fragment key={session.id}>
              {startsGroup ? (
                <li
                  className={`flex min-w-0 items-center gap-1.5 px-2.5 pb-1 text-[0.8125em] font-medium text-neutral-400 ${index === 0 ? "pt-1" : "pt-3"}`}
                  title={session.repoPath || (session.remote ? `No local checkout of ${session.remote.repo} is known yet` : undefined)}
                >
                  <RepoIcon className="size-4 shrink-0" />
                  <span className="truncate">{repository || "No repository"}</span>
                </li>
              ) : null}
              <li data-active={isActive || undefined}>
                <button
                  type="button"
                  onClick={() => void selectSession(session.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!isSubChat && !isCreating) setMenu({ sessionId: session.id, x: event.clientX, y: event.clientY });
                  }}
                  className={`group flex w-full flex-col items-start rounded py-1.5 pr-2 text-left transition-colors ${isActive ? "bg-(--row-selected)" : "hover:bg-(--row-hover)"}`}
                  style={{ paddingLeft: isSubChat ? "calc(10px + var(--sidebar-indent))" : 10 }}
                >
                  <span className="relative flex w-full items-center gap-2">
                    <SessionMark sessionId={session.id} mark={marks.get(session.id) ?? ""} />
                    <span className="min-w-0 flex-1 truncate text-[0.875em] font-medium text-neutral-100">{sidebarTitle(session)}</span>
                    {isCreating ? <span className="shrink-0 text-[0.75em] text-neutral-500">Starting</span> : null}
                    {remoteOriginLabel(session) ? (
                      <span
                        className="shrink-0 rounded-md bg-sky-400/10 px-1.5 text-[length:max(13px,0.875em)] leading-5 font-medium text-sky-300"
                        title={remoteOriginTitle(session) ?? undefined}
                      >
                        {remoteOriginLabel(session)}
                      </span>
                    ) : null}
                    {!isSubChat && !isCreating ? (
                      <span
                        role="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          startDraft(session.id);
                        }}
                        className="-my-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
                        title="Start another agent session in this worktree"
                        aria-label="New sub session"
                      >
                        <PlusIcon className="size-4" />
                      </span>
                    ) : null}
                    {!isCreating ? (
                      // Opaque backdrop so the button covers a long title; the row tint is layered over the sidebar colour.
                      <span
                        className={`absolute top-1/2 hidden -translate-y-1/2 rounded-md group-hover:flex ${isSubChat ? "-right-1" : "right-6"}`}
                        style={{ background: `linear-gradient(var(${isActive ? "--row-selected" : "--row-hover"}), var(${isActive ? "--row-selected" : "--row-hover"})), var(--sidebar-bg)` }}
                      >
                        <span
                          role="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeSession(session, isSubChat);
                          }}
                          className={`flex size-7 items-center justify-center rounded-md text-neutral-400 transition-colors ${session.remote && !isSubChat ? "hover:bg-white/10 hover:text-white" : "hover:bg-red-400/10 hover:text-red-400"}`}
                          title={session.remote && !isSubChat ? "Remove from the sidebar; the VM keeps running" : "Delete session"}
                          aria-label={session.remote && !isSubChat ? "Remove from sidebar" : "Delete session"}
                        >
                          <CloseIcon className="size-3.5" />
                        </span>
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 flex w-full min-w-0 items-center gap-1.5 pl-[26px] text-[0.9375em] text-neutral-400" title={isSubChat ? session.selection?.path : undefined}>
                    {isSubChat && session.selection ? (
                      <img src={fileIconUrl(session.selection.path)} alt="" className="size-4 shrink-0" />
                    ) : null}
                    {!isSubChat ? (session.pullRequest ? <GitHubIcon className="size-4 shrink-0" /> : <BranchIcon className="size-4 shrink-0" />) : null}
                    <span className="truncate">{isCreating && !isSubChat ? (session.workspace === "checkout" ? "Starting…" : "Creating worktree…") : sessionSubtitle(session)}</span>
                  </span>
                  {!isSubChat ? (
                    <span className="mt-0.5 flex w-full min-w-0 items-center gap-1.5 pl-[26px] text-[0.9375em] text-neutral-400">
                      <PushIcon className="size-4 shrink-0" />
                      <span className="truncate" title="Branch on origin a push of the session lands on">
                        {session.pushTarget}
                      </span>
                      {reference ? (
                        <span className={`ml-auto flex shrink-0 items-center gap-1 pl-2 ${REFERENCE_TONE[reference.tone]}`} title={reference.title || undefined}>
                          {reference.kind === "pullRequest" ? <PullRequestIcon className="size-4" /> : <TicketIcon className="size-4" />}
                          {reference.label}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {!isCreating && isBusy ? (
                    <span className="mt-0.5 flex w-full items-center gap-1 pl-2.5 text-[0.8125em]">
                      <span
                        role="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void cancelPrompt(session.id);
                        }}
                        className="rounded-md px-1.5 py-0.5 text-neutral-500 transition-colors hover:bg-white/10 hover:text-white"
                      >
                        stop
                      </span>
                    </span>
                  ) : null}
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
      <PlanUsageBar />
      {pendingDelete ? (
        <DeleteSessionDialog
          question={pendingDelete.question}
          isRemoval={pendingDelete.ending === "forget"}
          onConfirm={() => void closeSession(pendingDelete.sessionId, pendingDelete.ending)}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
      {menu && menuSession ? (
        <GitMenu
          title={sidebarTitle(menuSession)}
          x={menu.x}
          y={menu.y}
          entries={sessionMenuEntries(menuSession, sessions)}
          onClose={() => setMenu(null)}
          onPick={(entry) => {
            setMenu(null);
            setMenuError(null);
            if (entry.kind === "retarget") {
              setRetargetingId(menuSession.id);
              return;
            }
            if (entry.kind === "copyBranch") {
              void navigator.clipboard.writeText(menuSession.branch).catch((reason) => setMenuError(`failed to copy the branch name: ${String(reason)}`));
              return;
            }
            void commands.openWorktreeInTerminal(menuSession.id).catch((reason) => setMenuError(String(reason)));
          }}
        />
      ) : null}
      {retargeting?.pushTarget ? <SessionPushTargetDialog session={retargeting} target={retargeting.pushTarget} onClose={() => setRetargetingId(null)} /> : null}
      <StaleRemoteDialog />
    </div>
  );
}

/** The context menu of the top-level session `session` in the sidebar. */
function sessionMenuEntries(session: SessionView, sessions: SessionView[]): GitMenuEntry<"terminal" | "copyBranch" | "retarget">[] {
  const noWorktree = !session.hasLocalWorktree ? "The session has no local worktree yet; connect it first" : null;
  const retargetDisabledReason =
    remoteOf(session, sessions)?.origin === "swf" ? "A poller session pushes its own branch" : !session.pushTarget ? "The session has no local worktree yet; connect it first" : null;
  return [
    { kind: "terminal", label: "Open in Terminal", disabledReason: noWorktree, isDanger: false, startsGroup: false },
    { kind: "copyBranch", label: "Copy Branch Name", disabledReason: !session.branch ? "The session has no branch yet" : null, isDanger: false, startsGroup: false },
    { kind: "retarget", label: "Change Push Target…", disabledReason: retargetDisabledReason, isDanger: false, startsGroup: true },
  ];
}

/** The push target dialog for `session`, whose pushes land on `target` now, with the fetched branches of origin as choices. */
function SessionPushTargetDialog({ session, target, onClose }: { session: SessionView; target: string; onClose: () => void }) {
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useLoad(
    () => commands.gitRefs({ kind: "session", id: session.id }),
    {
      onValue: (refs) => setCandidates(refs.refs.map((ref) => (ref.kind === "remote" ? originBranchName(ref.name) : null)).filter((name): name is string => !!name)),
      onError: (reason) => setError(String(reason)),
    },
    [session.id],
  );
  return (
    <PushTargetDialog
      sessionId={session.id}
      branch={session.branch}
      current={target}
      candidates={candidates}
      candidatesError={error}
      onClose={onClose}
      onChanged={() => noteWorktreeChanged(session.id)}
    />
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

/**
 * The Claude account every Claude Code process Hunt starts uses, as a dropdown to switch it; accounts are added in the
 * settings. Turns red with the error as tooltip when the last load or switch failed.
 */
function AccountSwitcher() {
  const accounts = useAccountsStore((state) => state.accounts);
  const error = useAccountsStore((state) => state.error);
  const select = useAccountsStore((state) => state.select);

  return (
    <Dropdown
      title={error ? `Claude account: ${error}` : "Claude account of every Claude Code process Hunt starts"}
      value={accounts?.activeId ?? LOCAL_LOGIN}
      options={accountOptions(accounts)}
      onChange={(id) => void select(id)}
      disabled={!accounts}
      className={`mr-1 flex h-7 max-w-max min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-sm font-medium outline-none transition-colors hover:bg-(--row-hover) hover:text-neutral-100 ${error ? "text-red-300" : "text-neutral-300"}`}
    />
  );
}

/** Text colour of the pull request or issue badge on the push-target line, by `SessionReference.tone`. */
const REFERENCE_TONE: Record<ReferenceTone, string> = {
  amber: "text-amber-300",
  green: "text-emerald-300",
  grey: "text-neutral-400",
  purple: "text-violet-300",
  red: "text-red-300",
  neutral: "text-neutral-400",
};
