import type { RemoteLink, RemoteStep, RemoteTarget, SessionView } from "../ipc/types";
import { missingCheckoutBlocker } from "../sessions/remoteOrigin";
import type { FileSync, SessionChat } from "../state/store";

/** What the chat shows while a step of a handoff, a retrieval or a connect to the VM runs. */
export const REMOTE_STEP_LABELS: Record<RemoteStep, string> = {
  startingVm: "Starting the stopped VM…",
  resumingVm: "Waking the suspended VM…",
  movingVm: "Moving the VM to a zone with capacity…",
  creatingVm: "Creating the session's VM…",
  waitingForVm: "Waiting for the VM to finish its setup, the first boot takes a few minutes…",
  connecting: "Connecting to the VM…",
  installingRuntime: "Installing Hunt and the agent's tools on the VM…",
  transferringCode: "Transferring the code to the VM…",
  installingDependencies: "Installing dependencies on the VM…",
  startingAgent: "Starting the agent on the VM…",
  connectingAgent: "Connecting to the agent on the VM…",
  stoppingAgent: "Stopping the agent on the VM…",
  retrievingCode: "Bringing the code back…",
};

/** A remote operation whose steps the chat counts: a move to or from the VM, or a connect to it. */
export type RemoteOperation = "handOff" | "retrieve" | "connect";

/**
 * The steps of each remote operation in their order; a slot lists the steps that take its place, and several of them in
 * a row (a VM start that moves the VM to another zone) still count as one.
 */
const REMOTE_PLANS: Record<RemoteOperation, RemoteStep[][]> = {
  handOff: [
    ["connecting"],
    ["creatingVm", "startingVm", "resumingVm", "movingVm"],
    ["waitingForVm"],
    ["installingRuntime"],
    ["transferringCode"],
    ["installingDependencies"],
    ["startingAgent"],
  ],
  retrieve: [["connecting"], ["startingVm", "resumingVm", "movingVm"], ["waitingForVm"], ["installingRuntime"], ["stoppingAgent"], ["retrievingCode"]],
  connect: [["connecting"], ["startingVm", "resumingVm", "movingVm"], ["waitingForVm"], ["installingRuntime"], ["connectingAgent"]],
};

/** The operation the remote steps of `chat` belong to. */
export function remoteOperation(chat: SessionChat): RemoteOperation {
  return chat.move ?? "connect";
}

/**
 * How far an `operation` that reached `steps` got: the 1-based position of its furthest step and the number of steps it
 * runs. A step it skipped (one before the furthest that never ran, such as starting a VM that runs) leaves the count;
 * a step that runs again does not move the position back. `null` before it reached a step of its plan.
 */
export function remotePosition(operation: RemoteOperation, steps: RemoteStep[]): { position: number; total: number } | null {
  const plan = REMOTE_PLANS[operation];
  const slots = new Set(steps.map((step) => plan.findIndex((slot) => slot.includes(step))).filter((index) => index >= 0));
  if (!slots.size) return null;
  const skipped = Math.max(...slots) + 1 - slots.size;
  return { position: slots.size, total: plan.length - skipped };
}

/** `ms` as minutes and seconds, `1:05`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(Math.floor(ms / 1000), 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the chat says while its session waits to move to or from the VM; `null` while it does not wait. */
export function moveStatus(chat: SessionChat): string | null {
  if (!chat.move || chat.isLoading) return null;
  if (chat.move === "retrieve") return "The session comes back from the VM once the agent finished its turn.";
  return `The session moves to the VM ${chat.isBusy ? "once the agent finished its turn" : "as soon as it is ready"}.`;
}

/**
 * The VM the worktree of `session` lives on: its own while it is handed off, else its parent's for a sub chat, which
 * works in that session's worktree; `null` for a worktree only on this Mac. The agent of a sub chat runs on this Mac
 * either way, so use `session.remote` where the session's own agent or VM matters (its chat, moving it back, deleting
 * it, its preview and terminal).
 */
export function remoteOf(session: SessionView, sessions: SessionView[]): RemoteTarget | null {
  if (session.remote) return session.remote;
  if (!session.parentId) return null;
  return sessions.find((candidate) => candidate.id === session.parentId)?.remote ?? null;
}

/**
 * What else decides whether a session can move: the editor's unsaved edits, the selected Claude account and whether one
 * of its sub chats runs a turn.
 */
export type HandOffContext = { hasUnsavedEdits: boolean; hasClaudeAccount: boolean; hasBusySubChat: boolean };

/**
 * Why `session` cannot be handed off to the VM right now, or `null` when it can. Only a top-level session in a worktree
 * of its own moves, with a Claude account selected (the local login stays on this Mac), no unsaved edits in its editor
 * and no sub chat running a turn: moving the worktree stops their agents, which would cut a turn short. The session's own running turn does not block it: the handoff waits for its end (see `handOffSession`).
 */
export function handOffBlocker(session: SessionView, context: HandOffContext): string | null {
  if (session.parentId) return "A sub session runs here in its session's worktree.";
  if (session.workspace !== "worktree") return "Sessions in the repository's own checkout stay local.";
  if (session.pullRequest) return "Pull request reviews stay local.";
  if (!context.hasClaudeAccount) return "Pick a Claude account in the sidebar first; the local login cannot run on the VM.";
  if (context.hasUnsavedEdits) return "Save or discard the unsaved edits in the editor first.";
  if (context.hasBusySubChat) return "Wait until its sub chats finished their turns.";
  return null;
}

/**
 * What else decides whether a remote session can come back: the editor's unsaved edits, which the last sync would miss,
 * and whether one of its sub chats runs a turn.
 */
export type RetrieveContext = { hasUnsavedEdits: boolean; hasBusySubChat: boolean };

/**
 * Why the remote `session` cannot be brought back right now, or `null` when it can: an adopted session needs a local
 * checkout of its repository, the editor no unsaved edits, and no sub chat may run a turn, since its agent stops while
 * the worktree comes back. The session's own running turn does not block it:
 * the retrieval waits for its end.
 */
export function retrieveBlocker(session: SessionView, context: RetrieveContext): string | null {
  const missingCheckout = missingCheckoutBlocker(session);
  if (missingCheckout) return missingCheckout;
  if (context.hasUnsavedEdits) return "Save or discard the unsaved edits in the editor first.";
  if (context.hasBusySubChat) return "Wait until its sub chats finished their turns.";
  return null;
}

/** Whether a sub chat of `session` runs a turn, given the ids of the busy chats (`useBusyChatIds`). */
export function hasBusySubChat(session: SessionView, sessions: SessionView[], busyChatIds: ReadonlySet<string>): boolean {
  return sessions.some((candidate) => candidate.parentId === session.id && busyChatIds.has(candidate.id));
}

/**
 * The state of a remote session's file sync next to its "On VM" button: "Syncing…" while a sync runs and `isSlow` (it
 * ran for a moment, so quick ones do not flicker), "Sync failed" after a failure, the number of files the last one could
 * not sync; `null` when the files are in sync, which needs no label.
 */
export function fileSyncLabel(fileSync: FileSync, isSlow: boolean): string | null {
  if (fileSync.isRunning && isSlow) return "Syncing…";
  if (fileSync.error) return "Sync failed";
  if (fileSync.conflicts.length) return `${fileSync.conflicts.length} ${fileSync.conflicts.length === 1 ? "file" : "files"} not synced`;
  return null;
}

/**
 * The reason the local worktree of `sessionId` may not change right now, or `null` when it may: a remote session, and
 * each of its sub chats through it, is locked while its link (`remoteLinks`, by top-level session id) says so. A local
 * session, a session not listed and one whose link is not known yet are not locked; the backend still refuses a write
 * to a locked worktree.
 */
export function worktreeLock(sessions: SessionView[], remoteLinks: Record<string, RemoteLink>, sessionId: string): "vmRunning" | "unreachable" | null {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  const ownerId = session.parentId ?? session.id;
  const owner = sessions.find((candidate) => candidate.id === ownerId);
  const link = remoteLinks[ownerId];
  if (!owner?.remote || link?.state !== "locked") return null;
  return link.reason;
}

/** What an editor of a locked worktree says when someone types into it (Monaco's `readOnlyMessage`). */
export const WORKTREE_LOCKED_MESSAGE = "Local files are read-only while this Mac cannot sync with the VM.";

/** Whether the local worktree of `sessionId` may not change right now (see `worktreeLock`). */
export function isWorktreeLocked(sessions: SessionView[], remoteLinks: Record<string, RemoteLink>, sessionId: string): boolean {
  return worktreeLock(sessions, remoteLinks, sessionId) !== null;
}

/** The question that confirms continuing the remote session `ownerId`, whose VM cannot be reached, on this Mac. */
export function continueLocallyQuestion(ownerId: string): string {
  return (
    "Continue this session on this Mac?\n\nIt continues with the files as last synced and the conversation as of the agent's last finished turn. " +
    `What the agent did on the VM since is saved as the Git ref refs/hunt/${ownerId}/abandoned once the VM can be reached, then the VM is deleted.`
  );
}
