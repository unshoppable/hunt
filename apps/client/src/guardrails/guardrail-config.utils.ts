import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { AGENT_STEPS, type AgentStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import type { GuardrailDirs, SwfStepEntry } from "./guardrail.types";

/**
 * The folders of a repository whose hunt.json sets no `adrDir`: Claude Code reads rules, skills and subagents only from
 * these, while ADRs have no fixed place and go among the files Claude Code never loads on its own.
 */
export const DEFAULT_GUARDRAIL_DIRS: GuardrailDirs = { rule: ".claude/rules", skill: ".claude/skills", agent: ".claude/agents", adr: ".claude/resources/adrs" };

/** The repository's Hunt configuration, whose optional `adrDir` names the ADR folder. */
export const HUNT_JSON = "hunt.json";

/** `./docs/adr/` → `docs/adr`; null when nothing is left or the path is absolute or leaves the worktree. */
export function normalizeGuardrailDir(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  const segments = trimmed.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || trimmed.startsWith("/") || segments.includes("..")) return null;
  return segments.join("/");
}

/**
 * The ADR folder the text of a hunt.json sets as `adrDir`; the default without one or for an unreadable file or value,
 * which `hunt-ctl session-config` reports on a session VM.
 */
export function adrDirOf(huntJson: string): string {
  try {
    const adrDir: unknown = JSON.parse(huntJson)?.adrDir;
    return (typeof adrDir === "string" && normalizeGuardrailDir(adrDir)) || DEFAULT_GUARDRAIL_DIRS.adr;
  } catch {
    return DEFAULT_GUARDRAIL_DIRS.adr;
  }
}

/** The guardrail skill of a repository whose hunt.json sets no `guardrailSkill` (`DEFAULT_SKILL` in `src-tauri/src/agent/guardrail_skill.rs`). */
export const DEFAULT_GUARDRAIL_SKILL = "guardrail";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A skill name as Claude Code accepts it: kebab-case of letters and digits, at most 64 characters. */
export function isSkillName(name: string): boolean {
  return name.length <= 64 && SKILL_NAME.test(name);
}

/**
 * The guardrail skill the text of a hunt.json sets as `guardrailSkill`: the skill at `.claude/skills/<name>/SKILL.md`
 * the "Guardrail" button invokes; the default without one or for an unreadable file or value.
 */
export function guardrailSkillOf(huntJson: string): string {
  try {
    const skill: unknown = JSON.parse(huntJson)?.guardrailSkill;
    return typeof skill === "string" && isSkillName(skill) ? skill : DEFAULT_GUARDRAIL_SKILL;
  } catch {
    return DEFAULT_GUARDRAIL_SKILL;
  }
}

/**
 * The name of Hunt's template for the skill of the agent step `step` (`prompts/swf-<step>.skill.md`): the name the
 * "Software factory skills" dialog proposes to write into `swf.skills` of hunt.json for a step without an entry. It is no
 * runtime default: a step without an entry has no skill, which the session VM reports as a problem of hunt.json.
 */
export function proposedSwfSkill(step: AgentStep): string {
  return `swf-${step}`;
}

/**
 * The entries of `swf.skills` of a hunt.json with an `swf` section, one per agent step in the order of AGENT_STEPS: the
 * name the entry sets for the step, null without an entry or for a value that is no skill name. Null without the section
 * or for an unreadable file, since then the repository does not use Hunt's software factory.
 */
export function swfSkillsOf(huntJson: string): SwfStepEntry[] | null {
  try {
    const swf: unknown = JSON.parse(huntJson)?.swf;
    if (!isRecord(swf)) return null;
    const configured = swf.skills;
    return AGENT_STEPS.map((step) => {
      const name = isRecord(configured) ? configured[step] : undefined;
      return { step, name: typeof name === "string" && isSkillName(name) ? name : null };
    });
  } catch {
    return null;
  }
}
