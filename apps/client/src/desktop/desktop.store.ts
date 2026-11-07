import { create } from "zustand";
import type { DesktopStatus } from "./desktop-status.utils";

/** What a mounted Desktop panel reports of its stream: the status its header shows and the error below it. */
export type DesktopReport = { status: DesktopStatus; error: string | null };

type DesktopState = {
  /** By session ID, while the session's Desktop panel (desktop/DesktopPanel.tsx) is mounted. */
  reports: Record<string, DesktopReport>;
  /** Reconnects asked for outside the panel, counted by session ID; the mounted panel reconnects whenever its count grows. */
  reconnectRequests: Record<string, number>;
  /** Sets the report of the session's panel; null removes it, when the panel unmounts. */
  report: (sessionId: string, report: DesktopReport | null) => void;
  /** Asks the session's panel to reconnect as its Reconnect button does. */
  requestReconnect: (sessionId: string) => void;
};

/** The Desktop panel's stream as `hunt-client desktop` reads it and the reconnects it asks for. */
export const useDesktopStore = create<DesktopState>((set) => ({
  reports: {},
  reconnectRequests: {},
  report: (sessionId, report) =>
    set((state) => {
      if (!report) {
        if (!state.reports[sessionId]) return state;
        const { [sessionId]: _removed, ...reports } = state.reports;
        return { reports };
      }
      return { reports: { ...state.reports, [sessionId]: report } };
    }),
  requestReconnect: (sessionId) => set((state) => ({ reconnectRequests: { ...state.reconnectRequests, [sessionId]: (state.reconnectRequests[sessionId] ?? 0) + 1 } })),
}));
