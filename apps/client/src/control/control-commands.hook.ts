import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openDiffWindow } from "../diff/diff-window.utils";
import { openGuardrailsWindow } from "../guardrails/guardrails-window.utils";
import { openInEditorWindow } from "../ide/editor-window.utils";
import { useIdeStore } from "../ide/ide.store";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import { useHuntStore } from "../sessions/hunt.store";
import { useSessionViewStore } from "../sessions/inspector.store";
import { openSettingsWindow } from "../settings/settings-window.utils";
import type { ControlCommandEvent } from "./control-command.types";
import { ensureRunnable, parseControlCommand, worktreeFilePath } from "./control-command.utils";

const MAIN_WINDOW_LABEL = "main";

/**
 * Lets the main window run the `hunt-client` commands of the agents (see src-tauri/src/session/commands/control.rs):
 * every window and tab is opened from here, and only this window writes the inspector's tabs.
 */
export function useControlCommands(): void {
  useEffect(() => {
    const subscription = listenTo("control:command", (event) => void runAndAnswer(event), { target: MAIN_WINDOW_LABEL });
    return () => void subscription.then((unlisten) => unlisten());
  }, []);
}

/** Runs the command of `event` and answers it: with null once it ran, else with the reason it did not. */
async function runAndAnswer({ requestId, sessionId, command }: ControlCommandEvent): Promise<void> {
  let error: string | null = null;
  try {
    await runControlCommand(sessionId, command);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  await commands.answerControlCommand(requestId, error).catch((reason) => console.error(`failed to answer the control command ${requestId}: ${reason}`));
}

/** Checks `value` as a command of the session `sessionId` and runs it; throws an Error with the reason when it cannot. */
async function runControlCommand(sessionId: string, value: unknown): Promise<void> {
  const session = useHuntStore.getState().sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);
  const command = parseControlCommand(value);
  ensureRunnable(command, session);
  switch (command.name) {
    case "show": {
      const huntState = useHuntStore.getState();
      if (huntState.activeSessionId !== sessionId || huntState.draft) {
        void huntState.selectSession(sessionId);
      }
      // The main window's traffic light only hides it (see src-tauri/src/lib.rs).
      const mainWindow = getCurrentWindow();
      await mainWindow.show();
      await mainWindow.setFocus();
      return;
    }
    case "tab":
      useSessionViewStore.getState().setTab(sessionId, command.tab);
      return;
    case "openFile": {
      const path = worktreeFilePath(command.path, session.worktreePath);
      const position = { line: command.line, column: command.column };
      if (command.window) {
        await openInEditorWindow(sessionId, { path, ...position });
        return;
      }
      useSessionViewStore.getState().setTab(sessionId, "editor");
      useIdeStore.getState().openFile(sessionId, path, position);
      return;
    }
    case "openDiff":
      await openDiffWindow(sessionId, worktreeFilePath(command.path, session.worktreePath));
      return;
    case "openSettings":
      await openSettingsWindow(command.page);
      return;
    case "openGuardrails":
      await openGuardrailsWindow(sessionId);
      return;
    case "openBrowser":
      // The command itself, not the store's `openBrowser`, which reports a failure into the chat instead of rejecting.
      await commands.browserOpen(sessionId);
      return;
  }
}
