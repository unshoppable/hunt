import { useEffect, useRef, useState } from "react";
import { useIdeStore } from "../ide/ideStore";
import { useAccountsStore } from "../state/accounts";
import { configuredVmSettings, useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { SECONDARY_BUTTON_MD } from "../ui/buttons";
import { CloudIcon } from "../ui/icons";
import { useDismiss } from "../ui/useDismiss";
import { confirmVmLoss } from "../sessions/confirmVmLoss";
import { isAdopted } from "../sessions/remoteOrigin";
import { fileSyncLabel, handOffBlocker, retrieveBlocker } from "./remoteSession";

const MENU_ITEM = "block w-full rounded px-2 py-1 text-left enabled:hover:bg-(--row-hover) disabled:opacity-40";

/** How long a file sync runs before the header says so; quicker ones would only flicker. */
const SYNC_LABEL_DELAY_MS = 800;

/**
 * Chat header button of the session's place: hands a local session off to a VM of its own, created from the settings,
 * or brings a remote one back, which deletes its VM; an adopted session asks first, since others may work on it. Next to
 * it, a remote session shows the state of its file sync. Hidden while the remote settings are incomplete and the session
 * runs locally.
 */
export function RemoteMenu({ sessionId }: { sessionId: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const sessions = useHuntStore((state) => state.sessions);
  const chat = useHuntStore((state) => state.chats[sessionId]);
  const isCreating = useHuntStore((state) => state.creatingIds.includes(sessionId));
  const handOffSession = useHuntStore((state) => state.handOffSession);
  const retrieveSession = useHuntStore((state) => state.retrieveSession);
  const setRightTab = useHuntStore((state) => state.setRightTab);
  const remoteSettings = useSettingsStore((state) => state.remote);
  const hasUnsavedEdits = useIdeStore((state) => (state.sessions[sessionId]?.dirtyPaths.length ?? 0) > 0);
  const hasClaudeAccount = useAccountsStore((state) => Boolean(state.accounts?.activeId));
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSyncSlow, setIsSyncSlow] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useDismiss(menuRef, () => setIsMenuOpen(false), { anchorRefs: [buttonRef], closeOnWindowBlur: true, isEnabled: isMenuOpen });

  const isSyncRunning = Boolean(chat?.fileSync.isRunning);
  useEffect(() => {
    if (!isSyncRunning) {
      setIsSyncSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setIsSyncSlow(true), SYNC_LABEL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isSyncRunning]);

  const vmSettings = configuredVmSettings(remoteSettings);
  if (!session || (!vmSettings && !session.remote)) return null;
  const isRemote = Boolean(session.remote);
  const isRunning = Boolean(chat?.remoteStep) || Boolean(chat?.isLoading) || Boolean(chat?.move);
  const blocker = isRemote ? retrieveBlocker(session, { hasUnsavedEdits }) : handOffBlocker(session, sessions, { hasUnsavedEdits, hasClaudeAccount });
  const previewDomain = session.remote?.previewDomain ?? null;
  const instance = session.remote?.vm.instance ?? "";
  const syncLabel = isRemote && chat ? fileSyncLabel(chat.fileSync, isSyncSlow, formatSyncTime) : null;

  function run(action: (id: string) => Promise<void>) {
    setIsMenuOpen(false);
    void action(sessionId);
  }

  function showPreview() {
    setIsMenuOpen(false);
    setRightTab("preview");
  }

  async function bringBack() {
    setIsMenuOpen(false);
    if (!session || !(await confirmVmLoss(session, "bringBack"))) return;
    await retrieveSession(sessionId);
  }

  // A move asked for during a turn starts once the turn ended; a handoff starts the VM at once.
  const afterTurn = chat?.isBusy ? " It moves once the agent finished its turn." : "";
  const handOffHint = chat?.isBusy
    ? "The VM starts now; the agent moves there once it finished its turn and continues, also while Hunt is closed."
    : "The agent continues on its own VM, also while Hunt is closed.";
  const worktree = session.hasLocalWorktree ? "its local" : "a new";
  const bringBackHint = isAdopted(session)
    ? `The session continues here in ${worktree} worktree and its VM ${instance} is deleted, also for others working on it.${afterTurn}`
    : `The session continues here and its VM is deleted. Runs on ${instance}.${afterTurn}`;

  return (
    <div className="relative flex shrink-0 items-center gap-2">
      {syncLabel ? (
        <span className="text-[12px] text-neutral-500" title={chat?.fileSync.error ?? "Files are synced between the VM and this Mac in both directions."}>
          {syncLabel}
        </span>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsMenuOpen((current) => !current)}
        disabled={isCreating || isRunning}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        title={isRemote ? `Runs on the VM ${instance}` : "Run this session on a VM of its own"}
        className={`${SECONDARY_BUTTON_MD} ${isRemote ? "text-sky-300" : ""}`}
      >
        <CloudIcon className="size-4" />
        {isRemote ? "On VM" : "Remote"}
      </button>
      {isMenuOpen ? (
        <div
          ref={menuRef}
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 w-64 rounded border border-neutral-600 bg-(--surface-inset) p-1 text-[13px] font-normal shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            disabled={Boolean(blocker)}
            onClick={() => (isRemote ? void bringBack() : run(handOffSession))}
            className={MENU_ITEM}
          >
            {isRemote ? "Bring back from the VM" : "Hand off to the VM"}
            <span className="block text-[12px] text-neutral-500">
              {blocker ?? (isRemote ? bringBackHint : handOffHint)}
            </span>
          </button>
          {isRemote && previewDomain ? (
            <button type="button" role="menuitem" onClick={showPreview} className={MENU_ITEM}>
              Open preview
              <span className="block text-[12px] text-neutral-500">The Preview tab lists the services from hunt.json with their URLs and can have the agent start them.</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The time of day of the ISO timestamp `iso`, in hours and minutes. */
function formatSyncTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
