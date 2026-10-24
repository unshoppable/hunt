import { ask } from "@tauri-apps/plugin-dialog";
import { commands } from "../ipc/commands";
import { useSettingsStore, type GuardrailDirs } from "../state/settings";

const INSTRUCTION_FILE = "CLAUDE.md";
const GUARDRAILS_SECTION_HEADING = "## Guardrails";
const ADR_SECTION_HEADING = "## Architectural decisions";

/** A CLAUDE.md section Hunt offers to add: how to recognize it in a file, its text, and what the agent misses without it. */
export type InstructionSection = {
  isPresent: (content: string, dirs: GuardrailDirs) => boolean;
  build: (dirs: GuardrailDirs) => string;
  /** Completes "The CLAUDE.md of this repository does not tell Claude Code …" in the dialog. */
  missing: (dirs: GuardrailDirs) => string;
};

/** The sections in the order they are appended; the guardrails section names the ADR folder, so it comes first. */
const SECTIONS: InstructionSection[] = [
  {
    isPresent: hasGuardrailsInstruction,
    build: guardrailsSection,
    missing: () => "which guardrails it keeps, where each kind lives and what belongs in one",
  },
  {
    isPresent: (content, dirs) => hasAdrInstruction(content, dirs.adr),
    build: (dirs) => adrSection(dirs.adr),
    missing: (dirs) => `where its architectural decision records live, so the agent never looks into \`${dirs.adr}/\``,
  },
];

/**
 * The CLAUDE.md section that tells the agent which guardrails a repository keeps, where each kind lives and what
 * belongs in a new one. Without it an agent outside Hunt neither reads the rules, skills, agents and ADRs before it
 * works nor knows which knowledge is worth recording.
 */
export function guardrailsSection(dirs: GuardrailDirs): string {
  return [
    GUARDRAILS_SECTION_HEADING,
    "",
    "Guardrails are the instructions this repository records for agents; every change is measured against them. Before",
    "you start, read those that apply to your task, and follow them while you work:",
    "",
    "- `CLAUDE.md` files: what every change must respect. The root one is always loaded, one in a subfolder once you work",
    "  below that folder.",
    `- \`${dirs.rule}/*.md\`: conventions for one part of the code or one topic; a rule with \`paths:\` globs in its front`,
    "  matter is loaded only for the files they match.",
    `- \`${dirs.skill}/<name>/SKILL.md\`: workflows of several steps that recur.`,
    `- \`${dirs.agent}/<name>.md\`: specialist tasks delegated to a subagent.`,
    `- \`${dirs.adr}/NNNN-title.md\`: architectural decisions.`,
    "",
    "Only broadly reusable knowledge becomes a guardrail: a convention for a whole part of the code or a whole kind of task,",
    "a recurring problem together with its solution, or a workflow later sessions repeat. A decision about one piece of code,",
    "file, migration, data set, bug or task never does, nor how a single change was carried out. Before proposing one, check",
    "every kind above: a guardrail that repeats an existing one, whatever its kind, is a defect. The content decides the kind:",
    "a convention for every task goes into CLAUDE.md, one for part of the code into a rule, a recurring workflow into a skill,",
    "a delegable specialist task into an agent, an architectural decision into an ADR when it meets the criteria in",
    `\`${dirs.adr}/README.md\`. A convention that follows from a decision is a rule that names the decision as its reason,`,
    "not an ADR. Write a guardrail only when the user asks for it.",
  ].join("\n");
}

/** Whether an instruction file already explains the guardrails, recognized by the section heading. */
export function hasGuardrailsInstruction(content: string): boolean {
  return content.includes(GUARDRAILS_SECTION_HEADING);
}

/**
 * The CLAUDE.md section that tells the agent where the ADRs of a repository live and how to find one with `ls` and
 * `grep`. Without it Claude Code never looks into the ADR folder, so the records cannot guide its decisions.
 */
export function adrSection(adrDir: string): string {
  return [
    ADR_SECTION_HEADING,
    "",
    `Architectural decisions are recorded in \`${adrDir}/NNNN-title.md\`, one per file (Context, Decision, Consequences).`,
    `Before making or questioning an architectural decision, check for an existing one: \`ls ${adrDir}/\` lists them by`,
    `number and title, \`grep -ril <topic> ${adrDir}/\` finds those mentioning a topic (try a synonym when nothing matches).`,
    "Follow an existing decision; if a change contradicts one, say so and propose a new ADR instead of silently diverging.",
  ].join("\n");
}

/** Whether an instruction file already points the agent at the ADR folder: by the section heading or by naming the folder. */
export function hasAdrInstruction(content: string, adrDir: string): boolean {
  return content.includes(ADR_SECTION_HEADING) || content.includes(`${adrDir}/`);
}

/** The sections an instruction file lacks, in the order they are appended. */
export function missingSections(content: string, dirs: GuardrailDirs): InstructionSection[] {
  return SECTIONS.filter((section) => !section.isPresent(content, dirs));
}

/** The instruction file's content with `sections` appended, each after one blank line; an empty file holds the sections alone. */
export function withSections(content: string, sections: InstructionSection[], dirs: GuardrailDirs): string {
  const trimmed = content.replace(/\s+$/, "");
  const blocks = [trimmed, ...sections.map((section) => section.build(dirs))].filter(Boolean);
  return `${blocks.join("\n\n")}\n`;
}

/** Worktrees whose user declined the sections in this run of the app; they are asked again after a restart. */
const declined = new Set<string>();
/** Worktrees with a dialog open right now, so that two sessions of one worktree do not ask twice. */
const pending = new Set<string>();

/**
 * Makes sure the worktree's root CLAUDE.md explains the guardrails and tells the agent where the ADRs are: when a
 * section is missing, the user is asked once whether to add the missing ones, and on agreement they are appended to the
 * file as it is then (the file is created when missing). Once every section is in the file nothing is asked again; a
 * decline holds until the app restarts. A file that exists but cannot be read is never written. Failures are reported
 * to the console only, because the check is a courtesy on opening a session and must not disturb the chat.
 */
export async function ensureInstructionSections(sessionId: string, worktreePath: string): Promise<void> {
  if (declined.has(worktreePath) || pending.has(worktreePath)) return;
  const dirs = useSettingsStore.getState().guardrailDirs;
  pending.add(worktreePath);
  try {
    const content = await readInstructionFile(sessionId);
    const missing = missingSections(content, dirs);
    if (!missing.length) return;
    const agreed = await ask(
      `The ${INSTRUCTION_FILE} of this repository does not tell Claude Code:\n\n` +
        missing.map((section) => `• ${section.missing(dirs)}`).join("\n") +
        `\n\nAdd the missing sections to ${INSTRUCTION_FILE}? Existing content is kept.`,
      { title: `${INSTRUCTION_FILE} sections`, kind: "info", okLabel: "Add", cancelLabel: "Not now" },
    );
    if (!agreed) {
      declined.add(worktreePath);
      return;
    }
    const latest = await readInstructionFile(sessionId);
    const stillMissing = missingSections(latest, dirs);
    if (!stillMissing.length) return;
    await commands.writeFile(sessionId, INSTRUCTION_FILE, withSections(latest, stillMissing, dirs));
  } catch (error) {
    console.error(`failed to add the missing sections to ${INSTRUCTION_FILE}:`, error);
  } finally {
    pending.delete(worktreePath);
  }
}

/** The root CLAUDE.md of the session's worktree, empty when there is none; rejects when the worktree or the file cannot be read. */
async function readInstructionFile(sessionId: string): Promise<string> {
  const entries = await commands.listDir(sessionId, "");
  if (!entries.some((entry) => entry.name === INSTRUCTION_FILE && !entry.isDir)) return "";
  return commands.readFile(sessionId, INSTRUCTION_FILE);
}
