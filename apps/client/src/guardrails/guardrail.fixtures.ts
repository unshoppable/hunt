import type { Guardrail, GuardrailDirs, GuardrailListing } from "./guardrail.types";
import { DEFAULT_GUARDRAIL_DIRS } from "./guardrail-config.utils";

export const adr = (name: string): Guardrail => ({ kind: "adr", path: `.claude/resources/adrs/${name}.md`, name, folder: "" });
export const instruction = (folder: string): Guardrail => ({ kind: "instruction", path: folder ? `${folder}/CLAUDE.md` : "CLAUDE.md", name: "CLAUDE.md", folder: "" });
export const rule = (folder: string, name: string): Guardrail => ({ kind: "rule", path: `.claude/rules/${folder ? `${folder}/` : ""}${name}.md`, name, folder });
export const skill = (directory: string, name: string): Guardrail => ({ kind: "skill", path: `${directory}/${name}/SKILL.md`, name, folder: "" });
export const listing = (adrs: Guardrail[] = [], directories: Partial<GuardrailDirs> = {}, more: Partial<GuardrailListing> = {}): GuardrailListing => ({
  instruction: [],
  rule: [],
  skill: [],
  agent: [],
  adr: adrs,
  dirs: { ...DEFAULT_GUARDRAIL_DIRS, ...directories },
  folders: [],
  foundDirs: { rule: [], skill: [] },
  deletedAdrs: [],
  ...more,
});
