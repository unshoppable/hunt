import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionView } from "../ipc/types";
import { checkForUpdate } from "../ipc/updater";
import { useHuntStore } from "../state/store";
import { useSettingsStore } from "../state/settings";
import { openSettingsWindow } from "../settings/openSettingsWindow";
import { useFileIconUrl } from "../diff/fileIcons";
import { filterSessionRows, groupSessions, sessionSubtitle } from "./sessionLabels";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { HEADER_BAR } from "../ui/bars";
import { ICON_BUTTON, PRIMARY_BUTTON_SM } from "../ui/buttons";
import { SearchField } from "../ui/SearchField";
import { GitHubIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { useLoad } from "../ui/useLoad";

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
        <span data-tauri-drag-region="" className="truncate text-sm font-semibold tracking-wide text-neutral-300">Sessions</span>
        <span data-tauri-drag-region="" className="flex items-center gap-1">
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
            className={PRIMARY_BUTTON_SM}
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
                <span className="flex w-full items-center gap-2">
                  <span className={`size-2 shrink-0 rounded-full ${session.isLive ? "bg-emerald-400" : "bg-neutral-600"}`} />
                  <span className={`min-w-0 flex-1 truncate text-[0.875em] ${isSubChat ? "text-neutral-300" : "font-medium text-neutral-100"}`}>{session.title}</span>
                  {isCreating ? <span className="shrink-0 text-[0.75em] text-neutral-500">Starting</span> : isBusy ? <span className="shrink-0 text-[0.75em] text-sky-400">Working</span> : null}
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
                </span>
                <span className={`mt-0.5 flex w-full min-w-0 items-center gap-1 pl-4 text-[0.8125em] text-neutral-500 ${isSubChat ? "font-mono" : ""}`} title={isSubChat ? session.selection?.path : undefined}>
                  {isSubChat && session.selection ? (
                    <img src={fileIconUrl(session.selection.path)} alt="" className="size-3.5 shrink-0" />
                  ) : null}
                  {!isSubChat && session.pullRequest ? <GitHubIcon className="size-3.5 shrink-0" /> : null}
                  <span className="truncate">{isCreating && !isSubChat ? "Creating worktree…" : sessionSubtitle(session)}</span>
                </span>
                <span className={`mt-0.5 flex items-center gap-1 pl-2.5 text-[0.8125em] ${isCreating ? "invisible" : ""}`}>
                  {isBusy ? (
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
                  ) : null}
                  <span
                    role="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteSession(session, isSubChat);
                    }}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-500 transition-colors hover:bg-red-400/10 hover:text-red-400"
                  >
                    <TrashIcon className="size-3.5" />
                    delete
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {pendingDelete ? (
        <DeleteSessionDialog
          question={pendingDelete.question}
          onConfirm={() => void closeSession(pendingDelete.sessionId, true)}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
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
