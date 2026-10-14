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

/** A remote operation whose steps the chat counts: a move to or from the VM, or a connect to it. */
export type RemoteOperation = "handOff" | "retrieve" | "connect";

/** The steps of each remote operation in their order; a slot lists the steps that take its place. */
const REMOTE_PLANS: Record<RemoteOperation, RemoteStep[][]> = {
  handOff: [["connecting"], ["creatingVm", "startingVm"], ["waitingForVm"], ["installingRuntime"], ["transferringCode"], ["installingDependencies"], ["startingAgent"]],
  retrieve: [["connecting"], ["startingVm"], ["waitingForVm"], ["installingRuntime"], ["stoppingAgent"], ["retrievingCode"]],
  connect: [["connecting"], ["startingVm"], ["waitingForVm"], ["installingRuntime"], ["startingAgent"]],
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
