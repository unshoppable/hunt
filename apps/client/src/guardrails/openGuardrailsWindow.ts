import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useHuntStore } from "../state/store";
import { createWindow, type WindowDefaults } from "../ui/nativeWindow";

const GUARDRAILS_WINDOW_DEFAULTS: WindowDefaults = { width: 1200, height: 800, minWidth: 800, minHeight: 500, backgroundColor: "#272c35" };

/** Idle time after a session becomes active before its guardrails window boots; flicking through sessions boots nothing. */
const WARM_DELAY_MS = 400;

/** Windows booted ahead of time (hidden) that no click reached yet; they go when their session is left. */
const warm = new Set<string>();
/** Windows this window is creating, so a click while the warm one boots shows it instead of failing on the taken label. */
const creating = new Map<string, Promise<WebviewWindow>>();
let warmTimer: number | undefined;

/** Label of the guardrails window of a session; one window per session. */
export function guardrailsWindowLabel(sessionId: string): string {
  return `guardrails-${sessionId}`;
}

/**
 * Opens the session's guardrails in a window of their own (see GuardrailsWindow.tsx), from the chat header: a window
 * booted ahead of time or hidden by its close is only shown, otherwise a new one starts and shows itself once rendered.
 * It opens where the last guardrails window was left (see ui/nativeWindow.ts).
 */
export async function openGuardrailsWindow(sessionId: string): Promise<void> {
  const label = guardrailsWindowLabel(sessionId);
  warm.delete(label);
  const existing = await (creating.get(label) ?? WebviewWindow.getByLabel(label));
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  await createGuardrailsWindow(sessionId, { isWarm: false });
}

/**
 * Boots the active session's guardrails window hidden so that a click only has to show it, and destroys the windows
 * warmed for other sessions that nothing opened. Call whenever the active session changes.
 */
export function keepGuardrailsWindowWarm(sessionId: string | null): void {
  globalThis.clearTimeout(warmTimer);
  if (!sessionId) return;
  warmTimer = globalThis.setTimeout(() => {
    void dropWarmWindowsExcept(guardrailsWindowLabel(sessionId));
    const hasSession = useHuntStore.getState().sessions.some((session) => session.id === sessionId);
    if (hasSession) {
      void warmGuardrailsWindow(sessionId);
    }
  }, WARM_DELAY_MS);
}

async function warmGuardrailsWindow(sessionId: string): Promise<void> {
  const label = guardrailsWindowLabel(sessionId);
  if (creating.has(label) || (await WebviewWindow.getByLabel(label))) return;
  warm.add(label);
  await createGuardrailsWindow(sessionId, { isWarm: true }).catch(() => warm.delete(label));
}

async function dropWarmWindowsExcept(keptLabel: string): Promise<void> {
  for (const label of [...warm]) {
    if (label === keptLabel) continue;
    warm.delete(label);
    const window = await (creating.get(label) ?? WebviewWindow.getByLabel(label)).catch(() => null);
    // A window that was shown meanwhile is in use (it may hold unsaved edits) and stays.
    if (!window || (await window.isVisible().catch(() => true))) continue;
    await window.destroy().catch(() => {});
  }
}

/** Creates the session's guardrails window; a warm one stays hidden until `openGuardrailsWindow` shows it. */
async function createGuardrailsWindow(sessionId: string, { isWarm }: { isWarm: boolean }): Promise<WebviewWindow> {
  const label = guardrailsWindowLabel(sessionId);
  const title = useHuntStore.getState().sessions.find((session) => session.id === sessionId)?.title ?? "Guardrails";
  const params = new URLSearchParams({ session: sessionId });
  if (isWarm) {
    params.set("warm", "1");
  }
  const created = createWindow("guardrails", label, { url: `guardrails.html?${params}`, title: `Guardrails – ${title}`, ...GUARDRAILS_WINDOW_DEFAULTS });
  creating.set(label, created);
  try {
    const window = await created;
    void window.once("tauri://destroyed", () => warm.delete(label));
    return window;
  } finally {
    creating.delete(label);
  }
}
