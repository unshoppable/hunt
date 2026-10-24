import { create } from "zustand";
import { fillPrompt } from "../../../../libs/domain/src/prompts.ts";
import checkFailedPrompt from "../../prompts/check-failed.user-prompt.md?raw";
import checksSetupPrompt from "../../prompts/checks-setup.user-prompt.md?raw";
import { failureExcerpt } from "../checks/checks";
import { commands } from "../ipc/commands";
import type { ChecksStatus } from "../ipc/types";
import { decodeBase64 } from "../terminal/terminalStream";
import { errorText } from "../ui/useLoad";
import { useHuntStore } from "./store";

/** What Hunt knows about the checks of one session. */
export type SessionChecks = { status: ChecksStatus | null; error: string | null; isRefreshing: boolean };

export const EMPTY_CHECKS: SessionChecks = { status: null, error: null, isRefreshing: false };

type ChecksState = {
  checks: Record<string, SessionChecks>;
  /** Reads the checks of the session's hunt.json and their last runs; only the latest read lands. */
  refresh: (id: string) => Promise<void>;
  run: (id: string, name: string) => void;
  runAll: (id: string) => void;
  cancel: (id: string, name: string) => void;
  cancelAll: (id: string) => void;
  /** Sends the agent the failed check `name` with the end of its output. */
  sendFailure: (id: string, name: string) => Promise<void>;
  /** Asks the agent to declare the repository's checks in hunt.json. */
  setUp: (id: string) => void;
};

/** Bumped per session by every read of its checks, so that only the latest one lands. */
const statusReads = new Map<string, number>();

/** The checks of every session the Checks tab showed (see checks/ChecksPanel.tsx); `checks:changed` refreshes them. */
export const useChecksStore = create<ChecksState>((set, get) => {
  function update(id: string, change: (checks: SessionChecks) => SessionChecks) {
    set((state) => ({ checks: { ...state.checks, [id]: change(state.checks[id] ?? EMPTY_CHECKS) } }));
  }

  /** Runs `action` and puts its failure into the session's `error`. */
  async function report(id: string, action: () => Promise<unknown>) {
    try {
      await action();
      update(id, (current) => ({ ...current, error: null }));
    } catch (reason) {
      update(id, (current) => ({ ...current, error: errorText(reason) }));
    }
  }

  return {
    checks: {},

    refresh: async (id) => {
      const generation = (statusReads.get(id) ?? 0) + 1;
      statusReads.set(id, generation);
      update(id, (current) => ({ ...current, isRefreshing: true }));
      try {
        const status = await commands.checksStatus(id);
        if (statusReads.get(id) !== generation) return;
        update(id, (current) => ({ ...current, status, error: null }));
      } catch (reason) {
        if (statusReads.get(id) !== generation) return;
        update(id, (current) => ({ ...current, error: errorText(reason) }));
      } finally {
        if (statusReads.get(id) === generation) {
          update(id, (current) => ({ ...current, isRefreshing: false }));
        }
      }
    },

    run: (id, name) => void report(id, () => commands.runCheck(id, name)),
    runAll: (id) => void report(id, () => commands.runAllChecks(id)),
    cancel: (id, name) => void report(id, () => commands.cancelCheck(id, name)),
    cancelAll: (id) => void report(id, () => commands.cancelAllChecks(id)),

    sendFailure: (id, name) =>
      report(id, async () => {
        const definition = get().checks[id]?.status?.definitions.find((candidate) => candidate.name === name);
        const run = get().checks[id]?.status?.runs.find((candidate) => candidate.name === name);
        if (!definition || !run) throw new Error(`failed to send the check ${name}: it has no run`);
        const output = await commands.checkOutput(id, name);
        const text = output ? new TextDecoder().decode(decodeBase64(output.data)) : "";
        const prompt = fillPrompt(checkFailedPrompt.trim(), {
          name,
          command: definition.command,
          folder: definition.cwd ?? "the repository root",
          exitCode: run.exitCode === null ? "none" : String(run.exitCode),
          output: failureExcerpt(text),
        });
        await useHuntStore.getState().sendPrompt(id, prompt);
      }),

    setUp: (id) => void report(id, () => useHuntStore.getState().sendPrompt(id, checksSetupPrompt.trim())),
  };
});
