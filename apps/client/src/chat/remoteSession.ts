import type { RemoteStep, SessionView } from "../ipc/types";
import { missingCheckoutBlocker } from "../sessions/remoteOrigin";
import type { SessionChat } from "../state/store";

/** What the chat shows while a step of a handoff, a retrieval or a connect to the VM runs. */
export const REMOTE_STEP_LABELS: Record<RemoteStep, string> = {
  startingVm: "Starting the VM…",
  creatingVm: "Creating the session's VM…",
  waitingForVm: "Waiting for the VM to finish its setup, the first boot takes a few minutes…",
  connecting: "Connecting to the VM…",
  installingRuntime: "Installing Hunt and the agent's tools on the VM…",
  transferringCode: "Transferring the code to the VM…",
  installingDependencies: "Installing dependencies on the VM…",
  startingAgent: "Starting the agent on the VM…",
  stoppingAgent: "Stopping the agent on the VM…",
  retrievingCode: "Bringing the code back…",
};

/** What the chat shows while its session waits to move to or from the VM; `null` while it does not wait. */
export function moveStatus(chat: SessionChat): string | null {
  if (!chat.move || chat.isLoading) return null;
  const step = chat.remoteStep ? `${REMOTE_STEP_LABELS[chat.remoteStep]} ` : "";
  if (chat.move === "retrieve") return `${step}The session comes back from the VM once the agent finished its turn.`;
  return `${step}The session moves to the VM ${chat.isBusy ? "once the agent finished its turn" : "as soon as it is ready"}.`;
}

/** What else decides whether a session can move: the editor's unsaved edits and the selected Claude account. */
export type HandOffContext = { hasUnsavedEdits: boolean; hasClaudeAccount: boolean };

/**
 * Why `session` cannot be handed off to the VM right now, or `null` when it can. Only a top-level session in a worktree
 * of its own without sub sessions moves, with a Claude account selected (the local login stays on this Mac) and no
 * unsaved edits in its editor. A running turn does not block it: the handoff waits for its end (see `handOffSession`).
 */
export function handOffBlocker(session: SessionView, sessions: SessionView[], context: HandOffContext): string | null {
  if (session.parentId) return "A sub session runs where its parent runs.";
  if (session.workspace !== "worktree") return "Sessions in the repository's own checkout stay local.";
  if (session.pullRequest) return "Pull request reviews stay local.";
  if (sessions.some((candidate) => candidate.parentId === session.id)) return "Close its sub sessions first.";
  if (!context.hasClaudeAccount) return "Pick a Claude account in the sidebar first; the local login cannot run on the VM.";
  if (context.hasUnsavedEdits) return "Save or discard the unsaved edits in the editor first.";
  return null;
}

/**
 * Why the remote `session` cannot be brought back right now, or `null` when it can: an adopted session needs a local
 * checkout of its repository. A running turn does not block it: the retrieval waits for its end.
 */
export function retrieveBlocker(session: SessionView): string | null {
  return missingCheckoutBlocker(session);
}
