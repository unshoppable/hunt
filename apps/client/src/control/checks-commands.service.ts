import { useChecksStore } from "../checks/checks.store";
import { isAnyCheckRunning } from "../checks/checks.utils";
import { commands } from "../ipc/commands";
import { useSessionViewStore } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import { ensureDeclaredCheck, ensureRunningCheck } from "./checks-commands.utils";
import type { ChecksAction } from "./tab-commands.utils";

/**
 * Runs `action` on the Checks tab of `session` and shows that tab; without an action resolves to the tab's state, as
 * `hunt-client checks` prints it: the report the agent reads (`checks run` polls its `checks[].state`) and the check the
 * tab was told to show, `null` while it picks one itself. Stopping calls the backend itself, so a failure rejects.
 */
export async function runChecksCommand(session: SessionView, action: ChecksAction | undefined): Promise<unknown> {
  const { views, updateView, setTab } = useSessionViewStore.getState();
  if (!action) {
    const report = await useChecksStore.getState().readReport(session.id);
    return { ...report, selected: views[session.id]?.checksSelected ?? null };
  }
  const status = await commands.checksStatus(session.id);
  switch (action.name) {
    case "stop":
      if (action.check === undefined) {
        if (isAnyCheckRunning(status)) {
          await commands.cancelAllChecks(session.id);
        }
      } else {
        ensureRunningCheck(status, action.check);
        await commands.cancelCheck(session.id, action.check);
      }
      break;
    case "select":
      if (action.check !== null) {
        ensureDeclaredCheck(status, action.check);
      }
      updateView(session.id, { checksSelected: action.check });
      break;
  }
  setTab(session.id, "checks");
}
