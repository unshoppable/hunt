/** A step result the pipeline wrote (`.hunt/swf/steps/<nn>-<step>.md`): the run `n` it ended and that run's step (mirror of `SwfStepFile` in src-tauri/src/session/swf.rs). */
export type SwfStepFile = { n: number; step: string };

/**
 * What `.hunt/swf/` of a session's worktree holds, pulled from its VM (mirror of `SwfPipelineFiles` in
 * src-tauri/src/session/swf.rs; the commands are in src-tauri/src/session/commands/swf.rs): the parsed `pipeline.json`,
 * which the Factory tab validates against the record's schema (`libs/domain/src/swf/pipeline.domain.ts`), and the step
 * results in the order of their runs.
 */
export type SwfPipelineFiles = { pipeline: unknown; steps: SwfStepFile[] };

/** `.hunt/swf/` of the session was pulled from its VM (mirror of `SwfPulledEvent` in src-tauri/src/session/swf.rs). */
export type SwfPulledEvent = { huntSessionId: string };
