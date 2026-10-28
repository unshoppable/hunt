import type { AgentStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";

/** The kinds of guardrail that live in a folder of their own. */
export type GuardrailDirKind = "rule" | "skill" | "agent" | "adr";

/** The kinds of guardrail the guardrails window manages: `CLAUDE.md` instruction files anywhere in the worktree plus the folder-based kinds. */
export type GuardrailKind = "instruction" | GuardrailDirKind;

/** Worktree-relative folders the guardrails window reads and writes each folder-based kind in, without a trailing slash. */
export type GuardrailDirs = Record<GuardrailDirKind, string>;

export type Guardrail = {
  kind: GuardrailKind;
  /** Worktree-relative path of the Markdown file. */
  path: string;
  /** Display name: the rule, agent or ADR file without its extension, the skill folder, or `CLAUDE.md`. */
  name: string;
  /** Folder below the kind's directory the file lives in (`frontend/react`), `""` at its top; groups the list. For an instruction file, its worktree folder. */
  folder: string;
};

export type GuardrailListRow = { type: "folder"; folder: string; name: string; depth: number } | { type: "entry"; entry: Guardrail; depth: number };

export type GuardrailListing = Record<GuardrailKind, Guardrail[]> & {
  /** The folders (see `readGuardrailDirs`) the listing was read from and new guardrails go into. */
  dirs: GuardrailDirs;
  /** Every folder of the worktree holding a project file (see `foldersOf`), for the trees. */
  folders: string[];
  /**
   * Every rules and skills directory of the worktree: the configured one at the root (when it has content) and the
   * same path below any folder (`src/api/.claude/rules`), which Claude Code loads once it works in that folder.
   */
  foundDirs: Record<TreeDirKind, string[]>;
  /** File names of the ADRs the checked-out history deleted; their numbers are never given again. */
  deletedAdrs: string[];
};

/** Kinds whose directory Claude Code also reads below any folder of the worktree; their tabs show the folder tree. */
export type TreeDirKind = "rule" | "skill";

export type TreeRow =
  /** `hasEntry`: an entry is listed directly under the folder; `holdsEntries`: one is anywhere at or below it. */
  | { type: "folder"; path: string; name: string; depth: number; hasEntry: boolean; holdsEntries: boolean }
  | { type: "file"; entry: Guardrail; depth: number };

/** Help popover text of `kind`: what the files are, how Claude Code loads them, and when to use that kind rather than another. */
export type KindHelp = { what: string; loading: string; use: string };

/** Kinds the "New …" button creates; an instruction file is added to a folder of the tree instead. */
export type CreatableKind = Exclude<GuardrailKind, "instruction">;

/** Where a new guardrail goes: its kind's directory and, for a rule, the folder below it. */
export type GuardrailLocation = { dir: string; folder: string };

/**
 * The entry of `swf.skills` of a hunt.json for the agent step `step` of Hunt's swf pipeline: the `name` of the skill
 * (`.claude/skills/<name>/SKILL.md`) with which the repository refines the step, null when the entry is missing or holds
 * no valid skill name.
 */
export type SwfStepEntry = { step: AgentStep; name: string | null };

/**
 * What `createSwfSkills` creates for the agent step `step`: the skill `name` (`.claude/skills/<name>/SKILL.md`) from
 * Hunt's template of the step unless the file exists and, with `addEntry`, the entry `swf.skills.<step>` of hunt.json
 * unless it exists; mirrors `StepSkill` in `src-tauri/src/agent/swf_skills.rs`.
 */
export type SwfStepSkill = { step: AgentStep; name: string; addEntry: boolean };
