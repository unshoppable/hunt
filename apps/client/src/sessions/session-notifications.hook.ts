import { useEffect } from "react";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useHuntStore } from "./hunt.store";
import { notifiedState, statusNotification, type NotifiedState, type StatusNotification } from "./session-notification.utils";
import { pipelineAgentOf, useFactoryStore } from "./swf-pipeline.store";

/** Whether macOS lets Hunt notify, asked once per start; the first notification asks the user for it. */
let permission: Promise<boolean> | null = null;

function mayNotify(): Promise<boolean> {
  permission ??= isPermissionGranted()
    .then((isGranted) => isGranted || requestPermission().then((answer) => answer === "granted"))
    .catch((reason) => {
      console.error("failed to ask for the notification permission", reason);
      return false;
    });
  return permission;
}

function notify(notification: StatusNotification): void {
  void mayNotify().then((isAllowed) => {
    if (isAllowed) sendNotification(notification);
  });
}

/**
 * Sends a macOS notification whenever the agent of a session ends its turn (with a reply, a question or a failure) or
 * asks for a permission, unless the user looks at that session: it is the active one and this window has the focus.
 * The main window alone calls it, so that each step is told once.
 */
export function useSessionNotifications(): void {
  useEffect(() => {
    const states = new Map<string, NotifiedState>();
    const check = () => {
      const { sessions, chats, activeSessionId } = useHuntStore.getState();
      const { pipelines } = useFactoryStore.getState();
      for (const session of sessions) {
        const current = notifiedState(session, chats[session.id], pipelineAgentOf(pipelines[session.id]));
        if (!current) continue;
        const notification = statusNotification(session.title, states.get(session.id), current);
        states.set(session.id, current);
        const isWatched = session.id === activeSessionId && document.hasFocus();
        if (notification && !isWatched) notify(notification);
      }
    };
    check();
    const stopHunt = useHuntStore.subscribe(check);
    const stopFactory = useFactoryStore.subscribe(check);
    return () => {
      stopHunt();
      stopFactory();
    };
  }, []);
}
