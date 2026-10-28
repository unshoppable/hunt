import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listenTo } from "../ipc/events";
import { useHuntStore } from "./hunt.store";

const MAIN_WINDOW_LABEL = "main";

/** Shows `sessionId` in the main window's chat pane and brings that window to the front, from any window. */
export function showSessionInMainWindow(sessionId: string): void {
  if (getCurrentWindow().label === MAIN_WINDOW_LABEL) {
    void useHuntStore.getState().selectSession(sessionId);
    return;
  }
  void emitTo(MAIN_WINDOW_LABEL, "session:show", { sessionId });
}

/** Lets the main window take the `session:show` requests of the secondary windows. */
export function useShowSessionRequests(): void {
  useEffect(() => {
    const subscription = listenTo(
      "session:show",
      ({ sessionId }) => {
        void useHuntStore.getState().selectSession(sessionId);
        void getCurrentWindow().setFocus();
      },
      { target: MAIN_WINDOW_LABEL },
    );
    return () => void subscription.then((unlisten) => unlisten());
  }, []);
}
