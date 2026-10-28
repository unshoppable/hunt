import type { SessionView } from "./session.types";
import { hasPendingQuestion, type SessionChat } from "../chat/chat.store-slice";

/** What a session's mark shows of its agent: an arc while it works, a `?` while it waits for an answer. */
export type MarkState = { isBusy: boolean; hasQuestion: boolean };

/** The agent states the gateway records in which no step of the poller's pipeline is under way; empty when unknown. */
const IDLE_AGENT_STATES: ReadonlySet<string> = new Set(["", "question", "done", "failed"]);

/** Whether an agent state the gateway recorded (`RemoteTarget.agent`, `SessionVm.agent`) is a step of the poller's pipeline. */
export function isBusyAgentState(agent: string): boolean {
  return !IDLE_AGENT_STATES.has(agent);
}

/**
 * The state of `session`'s agent for its mark, from the best source at hand:
 * - a session that runs here, and a remote session connected with its conversation loaded: its chat;
 * - otherwise a remote session: what its relay last reported through the status channel (`remote.relayActivity`),
 *   with the chat or the gateway's record standing in for a relay too old to report questions; the gateway's
 *   `question` (an swf agent that asked on its issue) counts as well, but never while a turn runs;
 * - without such a report the chat of an earlier connect, else the agent state the gateway recorded (`remote.agent`).
 */
export function sessionMarkState(session: SessionView | undefined, chat: SessionChat | undefined): MarkState {
  const chatState = { isBusy: chat?.isBusy ?? false, hasQuestion: chat ? hasPendingQuestion(chat) : false };
  const remote = session?.remote;
  if (!remote) return chatState;
  if (session.isLive && chat && !chat.isLoading && !chat.isStale) return chatState;

  const hasConversation = Boolean(chat?.items.length);
  const activity = remote.relayActivity;
  if (activity) {
    const isQuestion = activity.isQuestion ?? (hasConversation ? chatState.hasQuestion : false);
    return { isBusy: activity.isTurnRunning, hasQuestion: !activity.isTurnRunning && (isQuestion || remote.agent === "question") };
  }
  if (hasConversation) return chatState;
  return { isBusy: chatState.isBusy || isBusyAgentState(remote.agent), hasQuestion: remote.agent === "question" };
}
