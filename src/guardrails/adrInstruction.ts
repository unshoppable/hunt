import { ask } from "@tauri-apps/plugin-dialog";
import { commands } from "../ipc/commands";
import { useSettingsStore } from "../state/settings";

const INSTRUCTION_FILE = "CLAUDE.md";
const ADR_SECTION_HEADING = "## Architectural decisions";

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
    "",
  ].join("\n");
}

/** Whether an instruction file already points the agent at the ADR folder: by the section heading or by naming the folder. */
export function hasAdrInstruction(content: string, adrDir: string): boolean {
  return content.includes(ADR_SECTION_HEADING) || content.includes(`${adrDir}/`);
}

/** The instruction file's content with the ADR section appended after one blank line; an empty file holds the section alone. */
export function withAdrSection(content: string, adrDir: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${adrSection(adrDir)}` : adrSection(adrDir);
}

/** Worktrees whose user declined the section in this run of the app; they are asked again after a restart. */
const declined = new Set<string>();
/** Worktrees with a dialog open right now, so that two sessions of one worktree do not ask twice. */
const pending = new Set<string>();

/**
 * Makes sure the worktree's root CLAUDE.md tells the agent where the ADRs are: when it does not, the user is asked once
 * whether to add the section, and on agreement it is appended to the file as it is then (the file is created when
 * missing). Once the section is in the file nothing is asked again; a decline holds until the app restarts. A file
 * that exists but cannot be read is never written. Failures are reported to the console only, because the check is a
 * courtesy on opening a session and must not disturb the chat.
 */
export async function ensureAdrInstruction(sessionId: string, worktreePath: string): Promise<void> {
  if (declined.has(worktreePath) || pending.has(worktreePath)) return;
  const adrDir = useSettingsStore.getState().guardrailDirs.adr;
  pending.add(worktreePath);
  try {
    const content = await readInstructionFile(sessionId);
    if (hasAdrInstruction(content, adrDir)) return;
    const agreed = await ask(
      `The ${INSTRUCTION_FILE} of this repository does not tell Claude Code where its architectural decision records live. ` +
        `Without that section the agent never looks into \`${adrDir}/\`, so the records cannot guide its decisions.\n\n` +
        `Add the section to ${INSTRUCTION_FILE}? Existing content is kept.`,
      { title: "Architectural decision records", kind: "info", okLabel: "Add section", cancelLabel: "Not now" },
    );
    if (!agreed) {
      declined.add(worktreePath);
      return;
    }
    const latest = await readInstructionFile(sessionId);
    if (hasAdrInstruction(latest, adrDir)) return;
    await commands.writeFile(sessionId, INSTRUCTION_FILE, withAdrSection(latest, adrDir));
  } catch (error) {
    console.error(`failed to add the ADR section to ${INSTRUCTION_FILE}:`, error);
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
