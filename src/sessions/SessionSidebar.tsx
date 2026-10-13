import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionView } from "../ipc/types";
import { checkForUpdate } from "../ipc/updater";
import { useHuntStore } from "../state/store";
import { useSettingsStore } from "../state/settings";
import { accountOptions, LOCAL_LOGIN, useAccountsStore } from "../state/accounts";
import { openSettingsWindow } from "../settings/openSettingsWindow";
import { useFileIconUrl } from "../diff/fileIcons";
import { cycleSessionId, filterSessionRows, groupSessions, sessionMarks, sessionSubtitle } from "./sessionLabels";
import { SessionMark } from "./SessionMark";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { StaleRemoteDialog } from "./StaleRemoteDialog";
import { PlanUsageBar } from "./PlanUsageBar";
import { HEADER_BAR } from "../ui/bars";
import { ICON_BUTTON, PRIMARY_BUTTON_XS } from "../ui/buttons";
import { Dropdown } from "../ui/Dropdown";
import { SearchField } from "../ui/SearchField";
import { BranchIcon, CloudIcon, GitHubIcon, PlusIcon, RepoIcon, TrashIcon } from "../ui/icons";
import { useLoad } from "../ui/useLoad";
import { repoName } from "../ui/path";

export function SessionSidebar() {
  const fileIconUrl = useFileIconUrl();
  const sessions = useHuntStore((state) => state.sessions);
  const activeSessionId = useHuntStore((state) => state.activeSessionId);
  const selectSession = useHuntStore((state) => state.selectSession);
  const closeSession = useHuntStore((state) => state.closeSession);
  const startDraft = useHuntStore((state) => state.startDraft);
  const cancelPrompt = useHuntStore((state) => state.cancelPrompt);
  const chats = useHuntStore((state) => state.chats);
  const creatingIds = useHuntStore((state) => state.creatingIds);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => filterSessionRows(groupSessions(sessions), query), [sessions, query]);
  const marks = useMemo(() => sessionMarks(sessions), [sessions]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /** The session the confirmation dialog is open for, with the question it shows. */
  const [pendingDelete, setPendingDelete] = useState<{ sessionId: string; question: string } | null>(null);
  /** Version of the newer Hunt the release feed offers; shown as a dot on the gear. */
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);

  // One quiet check per launch; a failed check shows nothing here, the Updates settings page reports it. Dev builds
  // carry no release version, so they do not check.
  useLoad(
    checkForUpdate,
    { onValue: (update) => setAvailableVersion(update?.version ?? null), onError: () => setAvailableVersion(null) },
    [],
    { isEnabled: !import.meta.env.DEV },
  );

  /**
   * Deletes the session (a top-level session takes its sub sessions and worktree along), after confirmation unless
   * the user turned the dialog off.
   */
  const deleteSession = (session: SessionView, isSubChat: boolean) => {
    if (!useSettingsStore.getState().confirmSessionDelete) {
      void closeSession(session.id, true);
      return;
    }
    const question = isSubChat
      ? `Delete sub session "${session.title}"?`
      : session.workspace === "checkout"
        ? `Delete session "${session.title}" and its sub sessions? The repository's checkout keeps its changes.`
        : `Delete session "${session.title}", its sub sessions and its worktree?`;
    setPendingDelete({ sessionId: session.id, question });
  };
  const deleteSessionRef = useRef(deleteSession);
  deleteSessionRef.current = deleteSession;

  // Cmd+, (Ctrl+, elsewhere) opens the settings like a native macOS app.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "," || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      void openSettingsWindow();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Ctrl+Tab selects the next session in the visible list, Ctrl+Shift+Tab the previous one, wrapping at both ends.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      event.preventDefault();
      const { activeSessionId, draft, selectSession } = useHuntStore.getState();
      const id = cycleSessionId(rowsRef.current, draft ? null : activeSessionId, event.shiftKey ? -1 : 1);
      if (id) void selectSession(id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘W while the focus is inside the sidebar deletes the selected session. Runs in the capture phase and stops the
  // event so the editor's own ⌘W (close tab) does not fire for the same key press.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "w" || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const active = document.activeElement;
      if (!active || !rootRef.current?.contains(active)) return;
      const { activeSessionId, sessions, draft } = useHuntStore.getState();
      const row = draft ? null : groupSessions(sessions).find(({ session }) => session.id === activeSessionId);
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      deleteSessionRef.current(row.session, row.isSubChat);
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
          <button
            type="button"
            onClick={() => void openSettingsWindow(availableVersion ? "updates" : undefined)}
            className={`${ICON_BUTTON} relative`}
            title={availableVersion ? `Settings · Hunt ${availableVersion} is available (⌘,)` : "Settings (⌘,)"}
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
      <SearchField value={query} onChange={setQuery} ariaLabel="Search sessions" className="mx-2 mt-[12px] mb-2" />
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2 font-(family-name:--sidebar-font-family) text-(length:--sidebar-font-size) leading-(--sidebar-line-height)">
        {query && rows.length === 0 ? <li className="px-2.5 py-1.5 text-[0.875em] text-neutral-500">No sessions match “{query}”</li> : null}
        {rows.map(({ session, isSubChat }) => {
          const isActive = session.id === activeSessionId;
          const isBusy = chats[session.id]?.isBusy ?? false;
          // A session the backend still creates has no worktree or agent yet: nothing can be started in or done to it.
          const isCreating = creatingIds.includes(session.id);
          return (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => void selectSession(session.id)}
                className={`group flex w-full flex-col items-start rounded-lg py-1.5 pr-2 text-left transition-colors ${isActive ? "bg-(--row-active)" : "hover:bg-(--row-hover)"}`}
                style={{ paddingLeft: isSubChat ? "calc(10px + var(--sidebar-indent))" : 10 }}
              >
                <span className="relative flex w-full items-center gap-2">
                  <SessionMark sessionId={session.id} mark={marks.get(session.id) ?? ""} />
                  <span className={`min-w-0 flex-1 truncate text-[0.875em] ${isSubChat ? "text-neutral-300" : "font-medium text-neutral-100"}`}>{session.title}</span>
                  {isCreating ? <span className="shrink-0 text-[0.75em] text-neutral-500">Starting</span> : null}
                  {session.remote ? (
                    <span className="flex shrink-0 text-sky-300" title={`Runs on the VM ${session.remote.vm.instance}`}>
                      <CloudIcon className="size-4" />
                    </span>
                  ) : null}
                  {!isSubChat && !isCreating && !session.remote ? (
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
                      className={`absolute top-1/2 hidden -translate-y-1/2 rounded-md group-hover:flex ${isSubChat || session.remote ? "-right-1" : "right-6"}`}
                      style={{ background: `linear-gradient(var(${isActive ? "--row-active" : "--row-hover"}), var(${isActive ? "--row-active" : "--row-hover"})), var(--sidebar-bg)` }}
                    >
                      <span
                        role="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteSession(session, isSubChat);
                        }}
                        className="flex size-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-red-400/10 hover:text-red-400"
                        title="Delete session"
                        aria-label="Delete session"
                      >
                        <TrashIcon className="size-3.5" />
                      </span>
                    </span>
                  ) : null}
                </span>
                <span className={`mt-0.5 flex w-full min-w-0 items-center gap-1.5 pl-[26px] text-[0.875em] text-neutral-500 ${isSubChat ? "font-mono tracking-tighter" : ""}`} title={isSubChat ? session.selection?.path : undefined}>
                  {isSubChat && session.selection ? (
                    <img src={fileIconUrl(session.selection.path)} alt="" className="size-4 shrink-0" />
                  ) : null}
                  {!isSubChat ? (session.pullRequest ? <GitHubIcon className="size-4 shrink-0" /> : <BranchIcon className="size-4 shrink-0" />) : null}
                  <span className="truncate">{isCreating && !isSubChat ? (session.workspace === "checkout" ? "Starting…" : "Creating worktree…") : sessionSubtitle(session)}</span>
                </span>
                {!isSubChat ? (
                  <span className="mt-0.5 flex w-full min-w-0 items-center gap-1.5 pl-[26px] text-[0.875em] text-neutral-500" title={session.repoPath}>
                    <RepoIcon className="size-4 shrink-0" />
                    <span className="truncate">{repoName(session.repoPath)}</span>
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
          );
        })}
      </ul>
      <PlanUsageBar />
      {pendingDelete ? (
        <DeleteSessionDialog
          question={pendingDelete.question}
          onConfirm={() => void closeSession(pendingDelete.sessionId, true)}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
      <StaleRemoteDialog />
    </div>
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
