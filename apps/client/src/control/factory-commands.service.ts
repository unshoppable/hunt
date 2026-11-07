import { useSessionViewStore } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import { EMPTY_PIPELINE, useFactoryStore } from "../sessions/swf-pipeline.store";
import { factoryState, type FactoryState } from "./factory-commands.utils";
import type { FactoryAction } from "./tab-commands.utils";

/**
 * Runs `action` on the Factory tab of `session` and shows that tab; without an action reads the pipeline's record
 * again (a read of the worktree's `.hunt/swf/`) and resolves to the tab's state, as `hunt-client factory` prints it.
 * `select` picks the run the tab shows (one of the record's runs; null leaves the choice to the tab), `refresh` reads
 * the record again as the Refresh button does, its failure landing in the record's error.
 */
export async function runFactoryCommand(session: SessionView, action: FactoryAction | undefined): Promise<FactoryState | undefined> {
  const { refresh } = useFactoryStore.getState();
  if (!action) {
    await refresh(session.id);
    return readFactoryState(session);
  }
  switch (action.name) {
    case "select": {
      if (!useFactoryStore.getState().pipelines[session.id]?.isLoaded) {
        await refresh(session.id);
      }
      const runs = useFactoryStore.getState().pipelines[session.id]?.pipeline?.runs ?? [];
      if (action.run !== null && !runs.some((run) => run.n === action.run)) {
        throw new Error(`the pipeline has no run ${action.run}; its runs are ${runs.map((run) => run.n).join(", ") || "none"}`);
      }
      useSessionViewStore.getState().updateView(session.id, { factoryRun: action.run });
      break;
    }
    case "refresh":
      void refresh(session.id);
      break;
  }
  useSessionViewStore.getState().setTab(session.id, "factory");
}

function readFactoryState(session: SessionView): FactoryState {
  const { pipeline, ...record } = useFactoryStore.getState().pipelines[session.id] ?? EMPTY_PIPELINE;
  const remote = session.remote;
  const claimedIssue = remote?.issue ? { repo: remote.repo, number: remote.issue } : null;
  return factoryState(record, pipeline, claimedIssue, useSessionViewStore.getState().views[session.id]?.factoryRun ?? null);
}
