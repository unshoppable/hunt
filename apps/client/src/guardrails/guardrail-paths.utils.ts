import { splitPath } from "../common/path/path.utils";
import type { DirEntry } from "../ide/project-tree/project-tree.types";
import type { Guardrail, GuardrailKind, GuardrailListing, GuardrailLocation } from "./guardrail.types";
import { normalizeGuardrailDir } from "./guardrail-config.utils";

/** Name of the instruction files Claude Code reads on its own, at the root and in any folder. */
export const INSTRUCTION_FILE = "CLAUDE.md";

/** Name of the file that makes a folder of a skills directory a skill. */
export const SKILL_FILE = "SKILL.md";

/** Whether `path` is an instruction file: `CLAUDE.md` at the root or in any folder. */
export function isInstructionFile(path: string): boolean {
  return path === INSTRUCTION_FILE || path.endsWith(`/${INSTRUCTION_FILE}`);
}

/** `My Rule Name!` → `my-rule-name`; empty when nothing usable is left. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Leading number of an ADR file name (`0007-use-postgres.md` → 7), null for files without one. */
export function adrNumber(fileName: string): number | null {
  const match = /^(\d+)[-_. ]/.exec(fileName);
  return match ? Number(match[1]) : null;
}

/** The number for the next ADR: one more than the highest one of an existing or a `deleted` ADR file, starting at 1. */
export function nextAdrNumber(existing: Guardrail[], deleted: string[] = []): number {
  const names = [...existing.map((adr) => adr.name), ...deleted];
  return Math.max(0, ...names.map((name) => adrNumber(name) ?? 0)) + 1;
}

/**
 * Path of a new guardrail named `title` in the listing's folders, null when `title` yields no usable file name. For
 * an instruction file `title` is the folder it goes into (empty for the repository root); the existing and deleted
 * ADRs decide the ADR's number. `location` names the directory (by default the kind's configured one) and, for a
 * rule, the folder below it.
 */
export function guardrailPath(kind: GuardrailKind, title: string, listing: GuardrailListing, location: Partial<GuardrailLocation> = {}): string | null {
  if (kind === "instruction") {
    if (!title.trim()) return INSTRUCTION_FILE;
    const instructionFolder = normalizeGuardrailDir(title);
    return instructionFolder ? `${instructionFolder}/${INSTRUCTION_FILE}` : null;
  }
  const slug = slugify(title);
  if (!slug) return null;
  const directory = location.dir ?? listing.dirs[kind];
  const folder = location.folder ?? "";
  switch (kind) {
    case "rule":
      return `${directory}/${folder ? `${folder}/` : ""}${slug}.md`;
    case "skill":
      return `${directory}/${slug}/${SKILL_FILE}`;
    case "agent":
      return `${listing.dirs.agent}/${slug}.md`;
    case "adr":
      return `${listing.dirs.adr}/${String(nextAdrNumber(listing.adr, listing.deletedAdrs)).padStart(4, "0")}-${slug}.md`;
  }
}

/** Starting content of a new guardrail, with its title filled in; `today` is used for the ADR date. */
export function guardrailTemplate(kind: GuardrailKind, title: string, listing: GuardrailListing, today = new Date()): string {
  const heading = title.trim();
  switch (kind) {
    case "instruction": {
      const dir = heading ? normalizeGuardrailDir(heading) : "";
      return `# ${dir ? `Instructions for ${dir}` : "Project instructions"}\n\n- \n`;
    }
    case "rule":
      return `# ${heading}\n\n- \n`;
    case "skill":
      return `---\nname: ${slugify(heading)}\ndescription: \n---\n\n# ${heading}\n\n## When to use\n\n\n## Steps\n\n1. \n`;
    case "agent":
      return `---\nname: ${slugify(heading)}\ndescription: \n---\n\n# ${heading}\n\nYou are \n`;
    case "adr":
      return `# ${nextAdrNumber(listing.adr, listing.deletedAdrs)}. ${heading}\n\nDate: ${today.toISOString().slice(0, 10)}\n\n## Context\n\n\n## Decision\n\n\n## Consequences\n\n`;
  }
}

/** What deleting `entry` removes: a skill's whole folder, otherwise the file itself. */
export function guardrailDeleteTarget(entry: Guardrail): string {
  return entry.kind === "skill" ? entry.path.slice(0, -`/${SKILL_FILE}`.length) : entry.path;
}

/** Whether a file named `name` is the Markdown file of a guardrail: a `.md` file other than a README. */
export function isGuardrailMarkdown(name: string): boolean {
  const lowerCaseName = name.toLowerCase();
  return lowerCaseName.endsWith(".md") && lowerCaseName !== "readme.md";
}

/** The names of the guardrail Markdown files among a folder's entries (see `isGuardrailMarkdown`). */
export function markdownFileNames(entries: readonly DirEntry[]): string[] {
  return entries.filter((entry) => !entry.isDir && isGuardrailMarkdown(entry.name)).map((entry) => entry.name);
}

/** The rule at `path` below the rules directory `directory`: named after its file, grouped by the folders between. */
export function ruleGuardrail(directory: string, path: string): Guardrail {
  const { dir: folder, name } = splitPath(path.slice(directory.length + 1, -".md".length));
  return { kind: "rule", path, name, folder };
}

/** Whether a folder of a skills directory, holding `entries`, is a skill: it has a SKILL.md. */
export function isSkillFolder(entries: readonly DirEntry[]): boolean {
  return entries.some((entry) => entry.name === SKILL_FILE);
}

/** The skill in the folder `name` of the skills directory `directory`. */
export function skillGuardrail(directory: string, name: string): Guardrail {
  return { kind: "skill", path: `${directory}/${name}/${SKILL_FILE}`, name, folder: "" };
}

/** The agents of the agents directory `directory` from its Markdown file names, by name. */
export function agentGuardrails(directory: string, fileNames: readonly string[]): Guardrail[] {
  const agents: Guardrail[] = fileNames.map((fileName) => ({ kind: "agent", path: `${directory}/${fileName}`, name: fileName.slice(0, -".md".length), folder: "" }));
  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

/** The ADRs of the ADR directory `directory` from its Markdown file names: the highest number first, then by name. */
export function adrGuardrails(directory: string, fileNames: readonly string[]): Guardrail[] {
  const adrs: Guardrail[] = fileNames.map((fileName) => ({ kind: "adr", path: `${directory}/${fileName}`, name: fileName.slice(0, -".md".length), folder: "" }));
  return adrs.sort((left, right) => (adrNumber(right.name) ?? 0) - (adrNumber(left.name) ?? 0) || left.name.localeCompare(right.name));
}
