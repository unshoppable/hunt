import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DiagramFileRequest } from "../common/diagram/diagram.types";
import { listenTo } from "../ipc/events";
import { useSettingsStore } from "../settings/settings.store";
import { useHuntStore } from "./hunt.store";
import { useSessionViewStore } from "./inspector.store";

const MAIN_WINDOW_LABEL = "main";

/**
 * Shows the diagram file `path` in the Architecture tab of the main window, from any window (the project tree also
 * lives in the editor window): the main window selects the session, remembers the file for it and opens the tab.
 */
export function showDiagramFile(request: DiagramFileRequest): void {
  if (getCurrentWindow().label === MAIN_WINDOW_LABEL) {
    openDiagramFile(request);
    return;
  }
  void emitTo(MAIN_WINDOW_LABEL, "architecture:show-file", request);
}

/** Lets the main window take the `architecture:show-file` requests of every window. */
export function useDiagramFileRequests(): void {
  useEffect(() => {
    const subscription = listenTo("architecture:show-file", openDiagramFile, { target: MAIN_WINDOW_LABEL });
    return () => void subscription.then((unlisten) => unlisten());
  }, []);
}

function openDiagramFile({ sessionId, path }: DiagramFileRequest): void {
  const huntState = useHuntStore.getState();
  if (huntState.activeSessionId !== sessionId || huntState.draft) {
    void huntState.selectSession(sessionId);
  }
  useSettingsStore.getState().setDiagramFile(sessionId, path);
  useSessionViewStore.getState().setTab(sessionId, "graph");
}
