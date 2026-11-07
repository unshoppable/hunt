import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openDiffWindow } from "../diff/diff-window.utils";
import { openGuardrailsWindow } from "../guardrails/guardrails-window.utils";
import { openInEditorWindow } from "../ide/editor-window.utils";
import { useIdeStore } from "../ide/ide.store";
import { useChecksStore } from "../checks/checks.store";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import { useHuntStore } from "../sessions/hunt.store";
import { useSessionViewStore, type RightTab } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import { useServicesStore } from "../terminal/services.store";
import { openSettingsWindow } from "../settings/settings-window.utils";
import { runChecksCommand } from "./checks-commands.service";
import type { ControlCommandEvent } from "./control-command.types";
import { ensureRunnable, parseControlCommand, sessionHasTab, worktreeFilePath } from "./control-command.utils";
import { runDesktopCommand } from "./desktop-commands.service";
import { runDiffCommand } from "./diff-commands.service";
import { runEditorCommand } from "./editor-commands.service";
import { runFactoryCommand } from "./factory-commands.service";
import { runGitCommand } from "./git-commands.service";
import { runGraphCommand } from "./graph-commands.service";
import { readPullRequestState } from "./pull-request-commands.service";
import { runTerminalCommand } from "./terminal-commands.service";

const MAIN_WINDOW_LABEL = "main";

/** How `hunt-client state` reads each tab; the mapped type makes the compiler insist on a reader per `RightTab`. */
const TAB_STATE_READERS: { [Tab in RightTab]: (session: SessionView) => Promise<unknown> } = {
  diff: (session) => runDiffCommand(session, undefined),
  git: (session) => runGitCommand(session, undefined),
  editor: (session) => runEditorCommand(session, undefined),
  graph: (session) => runGraphCommand(session, undefined),
  pullRequest: readPullRequestState,
  desktop: (session) => runDesktopCommand(session, undefined),
  checks: (session) => runChecksCommand(session, undefined),
  terminal: (session) => runTerminalCommand(session, undefined),
  factory: (session) => runFactoryCommand(session, undefined),
};

/** The tab the inspector of `session` shows, its remembered one or the last picked, and the Diff tab when it lacks that one (as `App` does), with that tab's state. */
async function readShownState(session: SessionView): Promise<{ tab: RightTab; state: unknown }> {
  const { views, lastTab } = useSessionViewStore.getState();
  const remembered = views[session.id]?.tab || lastTab;
  const tab = sessionHasTab(session, remembered) ? remembered : "diff";
  return { tab, state: await TAB_STATE_READERS[tab](session) };
}

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

/** Runs the command of `event` and answers it: with what it returned once it ran, else with the reason it did not. */
async function runAndAnswer({ requestId, sessionId, command }: ControlCommandEvent): Promise<void> {
  let error: string | null = null;
  let result: unknown;
  try {
    result = await runControlCommand(sessionId, command);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  await commands.answerControlCommand(requestId, error, result).catch((reason) => console.error(`failed to answer the control command ${requestId}: ${reason}`));
}

/** Checks `value` as a command of the session `sessionId` and runs it, returning its result if it has one; throws an Error with the reason when it cannot. */
async function runControlCommand(sessionId: string, value: unknown): Promise<unknown> {
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
    case "checks":
      return runChecksCommand(session, command.action);
    case "runChecks":
      return useChecksStore.getState().start(sessionId, command.check);
    case "services":
      return useServicesStore.getState().readReport(sessionId);
    case "startServices":
      return useServicesStore.getState().start(sessionId, command.service);
    case "stopService":
      return useServicesStore.getState().stop(sessionId, command.service);
    case "state":
      return readShownState(session);
    case "graph":
      return runGraphCommand(session, command.action);
    case "diff":
      return runDiffCommand(session, command.action);
    case "git":
      return runGitCommand(session, command.action);
    case "editor":
      return runEditorCommand(session, command.action);
    case "pullRequest":
      return readPullRequestState(session);
    case "desktop":
      return runDesktopCommand(session, command.action);
    case "terminal":
      return runTerminalCommand(session, command.action);
    case "factory":
      return runFactoryCommand(session, command.action);
  }
}
