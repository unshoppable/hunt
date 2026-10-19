import { useEffect, useState } from "react";
import { useIdeStore } from "../ide/ideStore";
import { useBusyChatIds } from "../ide/selectionChats";
import { useAccountsStore } from "../state/accounts";
import { configuredVmSettings, useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { SECONDARY_BUTTON_MD } from "../ui/buttons";
import { CloudIcon } from "../ui/icons";
import { confirmVmLoss } from "../sessions/confirmVmLoss";
import { isAdopted } from "../sessions/remoteOrigin";
import { fileSyncLabel, handOffBlocker, hasBusySubChat, retrieveBlocker } from "./remoteSession";

/** How long a file sync runs before the header says so; quicker ones would only flicker. */
const SYNC_LABEL_DELAY_MS = 800;

/**
 * Chat header toggle of the session's place: a click hands a local session off to a VM of its own, created from the
 * settings, or brings a remote one back, which deletes its VM; an adopted session asks
 * first, since others may work on it. The tooltip explains the click or why it is blocked, in which case a click does
 * nothing and the button is dimmed. Next to it, a remote session shows the state of its file sync. Hidden while the
 * remote settings are incomplete and the session runs locally, and for a sub chat, whose agent runs on this Mac in its
 * session's worktree wherever the session runs.
 */
export function RemoteToggle({ sessionId }: { sessionId: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const sessions = useHuntStore((state) => state.sessions);
  const chat = useHuntStore((state) => state.chats[sessionId]);
  const isCreating = useHuntStore((state) => state.creatingIds.includes(sessionId));
  const handOffSession = useHuntStore((state) => state.handOffSession);
  const retrieveSession = useHuntStore((state) => state.retrieveSession);
  const remoteSettings = useSettingsStore((state) => state.remote);
  const hasUnsavedEdits = useIdeStore((state) => (state.sessions[sessionId]?.dirtyPaths.length ?? 0) > 0);
  const hasClaudeAccount = useAccountsStore((state) => Boolean(state.accounts?.activeId));
  const busyChatIds = useBusyChatIds();
  const [isSyncSlow, setIsSyncSlow] = useState(false);

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
  if (!session || session.parentId) return null;
  if (!vmSettings && !session.remote) return null;
  const isRemote = Boolean(session.remote);
  const isRunning = Boolean(chat?.remoteStep) || Boolean(chat?.isLoading) || Boolean(chat?.move);
  const context = { hasUnsavedEdits, hasClaudeAccount, hasBusySubChat: hasBusySubChat(session, sessions, busyChatIds) };
  const blocker = isRemote ? retrieveBlocker(session, context) : handOffBlocker(session, context);
  const instance = session.remote?.vm.instance ?? "";
  const syncLabel = isRemote && chat ? fileSyncLabel(chat.fileSync, isSyncSlow) : null;

  async function toggle() {
    if (!session) return;
    if (!isRemote) {
      await handOffSession(sessionId);
      return;
    }
    if (!(await confirmVmLoss(session, "bringBack"))) return;
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
  const title = blocker ?? (isRemote ? `Bring back from the VM: ${bringBackHint}` : `Hand off to the VM: ${handOffHint}`);

  return (
    <div className="flex shrink-0 items-center gap-2">
      {syncLabel ? (
        <span className="text-[12px] text-neutral-500" title={chat?.fileSync.error ?? "Files are synced between the VM and this Mac in both directions."}>
          {syncLabel}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => (blocker ? undefined : void toggle())}
        disabled={isCreating || isRunning}
        aria-disabled={Boolean(blocker)}
        aria-pressed={isRemote}
        title={title}
        className={`${SECONDARY_BUTTON_MD} ${isRemote ? "text-sky-300" : ""} ${blocker ? "opacity-40" : ""}`}
      >
        <CloudIcon className="size-4" />
        {isRemote ? "On VM" : "Remote"}
      </button>
    </div>
  );
}
