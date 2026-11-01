import { create } from "zustand";
import type * as z from "zod/mini";
import { Pipeline } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { commands } from "../ipc/commands";
import { errorText } from "../ui/error-text.utils";
import type { SwfStepFile } from "./swf-pipeline.types";
import { pipelineAgentState } from "./swf-pipeline.utils";

/**
 * What Hunt read of one session's swf pipeline from `.hunt/swf/` of its worktree: `pipeline` is null while the pipeline
 * wrote no record yet (`isLoaded` tells that apart from a read still to come) or while the record is unreadable
 * (`error` says why); `steps` lists the step results that can be opened.
 */
export type SessionPipeline = { pipeline: Pipeline | null; steps: SwfStepFile[]; isLoaded: boolean; isLoading: boolean; error: string | null };

export const EMPTY_PIPELINE: SessionPipeline = { pipeline: null, steps: [], isLoaded: false, isLoading: false, error: null };

type FactoryState = {
  pipelines: Record<string, SessionPipeline>;
  /** Reads the pipeline's record and step results of the session again; only the latest read lands. */
  refresh: (id: string) => Promise<void>;
};

/** Bumped per session by every read of its pipeline, so that only the latest one lands. */
const reads = new Map<string, number>();

/** The pipelines of the swf sessions, read when the Factory tab (factory/FactoryPanel.tsx) shows one and after every pull of `.hunt/swf/` (`swf:pulled`); the sidebar's marks and chips read them too. */
export const useFactoryStore = create<FactoryState>((set) => {
  function update(id: string, change: (current: SessionPipeline) => SessionPipeline) {
    set((state) => ({ pipelines: { ...state.pipelines, [id]: change(state.pipelines[id] ?? EMPTY_PIPELINE) } }));
  }

  return {
    pipelines: {},

    refresh: async (id) => {
      const generation = (reads.get(id) ?? 0) + 1;
      reads.set(id, generation);
      update(id, (current) => ({ ...current, isLoading: true }));
      try {
        const files = await commands.readSwfPipeline(id);
        if (reads.get(id) !== generation) return;
        if (!files) {
          update(id, (current) => ({ ...current, pipeline: null, steps: [], isLoaded: true, error: null }));
          return;
        }
        const parsed = Pipeline.schema.safeParse(files.pipeline);
        update(id, (current) =>
          parsed.success
            ? { ...current, pipeline: new Pipeline(parsed.data), steps: files.steps, isLoaded: true, error: null }
            : { ...current, pipeline: null, steps: files.steps, isLoaded: true, error: `The pipeline record could not be read: ${describeIssue(parsed.error.issues[0])}` },
        );
      } catch (reason) {
        if (reads.get(id) !== generation) return;
        update(id, (current) => ({ ...current, isLoaded: true, error: errorText(reason) }));
      } finally {
        if (reads.get(id) === generation) {
          update(id, (current) => ({ ...current, isLoading: false }));
        }
      }
    },
  };
});

/** `issue` in words; zod/mini words every issue "Invalid input", so the field is what tells the reader where to look. */
function describeIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "invalid record";
  const field = issue.path.length ? issue.path.join(".") : "the record";
  return `${field}: ${issue.message}`;
}

/**
 * The state of a session's agent as its pipeline's record tells it (see `pipelineAgentState`), for the sidebar's mark
 * and chip; null while the Factory tab read no record of the session.
 */
export function pipelineAgentOf(record: SessionPipeline | undefined): string | null {
  return record?.pipeline ? pipelineAgentState(record.pipeline) : null;
}
