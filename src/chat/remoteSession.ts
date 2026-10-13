import type { RemoteStep, SessionView } from "../ipc/types";
import type { SessionChat } from "../state/store";

/** What the chat shows while a step of a handoff, a retrieval or a connect to the VM runs. */
export const REMOTE_STEP_LABELS: Record<RemoteStep, string> = {
  startingVm: "Starting the VM…",
  creatingVm: "Creating the session's VM…",
  waitingForVm: "Waiting for the VM to finish its setup, the first boot takes a few minutes…",
  connecting: "Connecting to the VM…",
  installingRuntime: "Installing Hunt's runtime on the VMs…",
  transferringCode: "Transferring the code to the VM…",
  installingDependencies: "Installing dependencies on the VM…",
  startingAgent: "Starting the agent on the VM…",
  stoppingAgent: "Stopping the agent on the VM…",
  retrievingCode: "Bringing the code back…",
};

/** Why nothing may move while the chat waits for something; `null` when it does not. */
function waitingChatBlocker(chat: SessionChat | undefined): string | null {
  if (chat?.isBusy) return "Wait until the agent finished its turn.";
  if (chat?.queue.length) return "Send or take back the queued prompts first.";
  if (chat?.permission) return "Answer the agent's question first.";
  return null;
}

/** What else decides whether a session can move: the editor's unsaved edits and the selected Claude account. */
export type HandOffContext = { hasUnsavedEdits: boolean; hasClaudeAccount: boolean };

/**
 * Why `session` cannot be handed off to the VM right now, or `null` when it can. Only a top-level session in a worktree
 * of its own without sub sessions moves, with a Claude account selected (the local login stays on this Mac); nothing
 * may wait in its chat or editor.
 */
export function handOffBlocker(session: SessionView, sessions: SessionView[], chat: SessionChat | undefined, context: HandOffContext): string | null {
  if (session.parentId) return "A sub session runs where its parent runs.";
  if (session.workspace !== "worktree") return "Sessions in the repository's own checkout stay local.";
  if (session.pullRequest) return "Pull request reviews stay local.";
  if (sessions.some((candidate) => candidate.parentId === session.id)) return "Close its sub sessions first.";
  if (!context.hasClaudeAccount) return "Pick a Claude account in the sidebar first; the local login cannot run on the VM.";
  if (context.hasUnsavedEdits) return "Save or discard the unsaved edits in the editor first.";
  return waitingChatBlocker(chat);
}

/** Why the remote session with `chat` cannot be brought back right now, or `null` when it can. */
export function retrieveBlocker(chat: SessionChat | undefined): string | null {
  return waitingChatBlocker(chat);
}
