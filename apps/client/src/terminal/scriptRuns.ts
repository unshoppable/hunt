import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listenTo } from "../ipc/events";
import type { ScriptRunRequest } from "../ipc/types";
import { useSessionViewStore } from "../state/sessionViews";
import { useHuntStore } from "../state/store";
import { useTerminalStore } from "../state/terminals";

const MAIN_WINDOW_LABEL = "main";

/**
 * Runs a package.json script in the Terminal tab of the main window, from any window: a local session runs it in a tmux
 * window of its own on this Mac, a remote session in a new tmux window on its VM. The main window shows the session and
 * its Terminal tab.
 */
export function runPackageScript(request: ScriptRunRequest): void {
  if (getCurrentWindow().label === MAIN_WINDOW_LABEL) {
    startScriptRun(request);
    return;
  }
  void emitTo(MAIN_WINDOW_LABEL, "terminal:run-script", request);
}

/** Lets the main window take the `terminal:run-script` requests of every window. */
export function useScriptRunRequests(): void {
  useEffect(() => {
    const subscription = listenTo("terminal:run-script", startScriptRun, { target: MAIN_WINDOW_LABEL });
    return () => void subscription.then((unlisten) => unlisten());
  }, []);
}

function startScriptRun(request: ScriptRunRequest): void {
  const { sessionId } = request;
  const huntState = useHuntStore.getState();
  if (huntState.activeSessionId !== sessionId || huntState.draft) {
    void huntState.selectSession(sessionId);
  }
  useSessionViewStore.getState().setTab(sessionId, "terminal");
  useTerminalStore.getState().requestScript(request);
}
