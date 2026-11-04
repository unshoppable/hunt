/** What kind of guardrail a file in the agent's context is; mirrors `ContextKind` in `agent/loaded_context.rs`. */
export type LoadedContextKind = "instructions" | "rule" | "memory" | "skill" | "adr" | "resource";

/** How a file got into the agent's context; mirrors `LoadTrigger` in `agent/loaded_context.rs`. */
export type LoadTrigger = "start" | "path" | "invoked" | "read";

/** One file in the agent's context window; mirrors `ContextFile` in `agent/loaded_context.rs`. */
export type LoadedContextFile = {
  kind: LoadedContextKind;
  trigger: LoadTrigger;
  /** Relative to the worktree when inside it, absolute otherwise; a skill's `SKILL.md`. */
  path: string;
  isInWorktree: boolean;
};

/** What a part of the agent's context is; mirrors `PartKind` in `agent/context_parts.rs`. */
export type ContextPartKind =
  | "systemPrompt"
  | "tools"
  | "instructions"
  | "reminder"
  | "skill"
  | "summary"
  | "user"
  | "assistant"
  | "thinking"
  | "toolCall"
  | "toolResult";

/** One part of the text of the agent's context window; mirrors `ContextPart` in `agent/context_parts.rs`. */
export type ContextPart = { kind: ContextPartKind; title: string; text: string };
