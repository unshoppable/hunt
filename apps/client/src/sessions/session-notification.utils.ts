import type { SessionView } from "./session.types";
import type { SessionChat } from "../chat/chat.store-slice";
import { sessionMarkState } from "./session-mark-state.utils";

/** What of a session's agent a status notification tells: the state of its mark plus the permission it asks for. */
export type NotifiedState = {
  isBusy: boolean;
  hasQuestion: boolean;
  /** The pending permission request, with the title of the tool call it is for; null without one. */
  permission: { requestId: string; title: string | null } | null;
  /** Why the last turn failed; null when it did not. */
  error: string | null;
};

/** A notification of macOS' notification centre: the session's title and what its agent wants. */
export type StatusNotification = { title: string; body: string };

/**
 * The notified state of `session`'s agent (see `sessionMarkState` for its sources); null while its chat loads, when the
 * state is not known and the last one stands.
 */
export function notifiedState(session: SessionView, chat: SessionChat | undefined, pipelineAgent: string | null): NotifiedState | null {
  if (chat?.isLoading) return null;
  const permission = chat?.permission ? { requestId: chat.permission.requestId, title: chat.permission.toolCall.title ?? null } : null;
  return { ...sessionMarkState(session, chat, pipelineAgent), permission, error: chat?.error ?? null };
}

/**
 * The notification the step from `previous` to `current` calls for: the agent asks for a permission it did not ask
 * for before, or its turn ended, with a question, a failure or a plain reply. Null for every other step, and for a
 * session seen for the first time, whose turn may have ended long ago.
 */
export function statusNotification(title: string, previous: NotifiedState | undefined, current: NotifiedState): StatusNotification | null {
  if (!previous) return null;
  if (current.permission && current.permission.requestId !== previous.permission?.requestId) {
    return { title, body: current.permission.title ? `Asks for permission: ${current.permission.title}` : "Asks for permission" };
  }
  if (!previous.isBusy || current.isBusy) return null;
  if (current.hasQuestion) return { title, body: "Waiting for your answer" };
  if (current.error) return { title, body: `Failed: ${current.error}` };
  return { title, body: "Finished its turn" };
}
