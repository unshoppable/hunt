import { useHuntStore } from "../state/store";
import { openOrFocusWindow } from "../ui/nativeWindow";

/** Label of the guardrails window of a session; one window per session. */
export function guardrailsWindowLabel(sessionId: string): string {
  return `guardrails-${sessionId}`;
}

/**
 * Opens the session's guardrails in a window of their own (see GuardrailsWindow.tsx), from the chat header, or
 * brings the open one to the front. It opens where the last guardrails window was left (see ui/nativeWindow.ts).
 */
export async function openGuardrailsWindow(sessionId: string): Promise<void> {
  const title = useHuntStore.getState().sessions.find((session) => session.id === sessionId)?.title ?? "Guardrails";
  const params = new URLSearchParams({ session: sessionId });
  await openOrFocusWindow("guardrails", guardrailsWindowLabel(sessionId), {
    url: `guardrails.html?${params}`,
    title: `Guardrails – ${title}`,
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: "#272c35",
  });
}
