import { useDesktopStore } from "../desktop/desktop.store";
import type { Tone } from "../desktop/desktop-status.utils";
import { useSessionViewStore } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import type { DesktopAction } from "./tab-commands.utils";

/**
 * The Desktop tab as `hunt-client desktop` prints it: whether its panel is open (it is mounted only for the session the
 * main window shows), the status its header shows, whether it connects and offers Reconnect, and the error below it;
 * a closed panel has no status.
 */
export type DesktopTabState = { isOpen: boolean; status: string | null; tone: Tone | null; isBusy: boolean; canReconnect: boolean; error: string | null };

/**
 * Runs `action` on the Desktop tab of `session` and shows that tab; without an action resolves to the tab's state, as
 * `hunt-client desktop` prints it. `reconnect` asks the panel to connect again as its Reconnect button does; a panel
 * that is not open connects anew when it opens.
 */
export async function runDesktopCommand(session: SessionView, action: DesktopAction | undefined): Promise<DesktopTabState | undefined> {
  if (!action) return readDesktopState(session.id);
  switch (action.name) {
    case "reconnect":
      useDesktopStore.getState().requestReconnect(session.id);
      useSessionViewStore.getState().setTab(session.id, "desktop");
      return;
  }
}

function readDesktopState(sessionId: string): DesktopTabState {
  const report = useDesktopStore.getState().reports[sessionId];
  if (!report) return { isOpen: false, status: null, tone: null, isBusy: false, canReconnect: false, error: null };
  const { text, tone, isBusy, canReconnect } = report.status;
  return { isOpen: true, status: text, tone, isBusy, canReconnect, error: report.error };
}
