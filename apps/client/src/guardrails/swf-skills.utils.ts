import { ask } from "@tauri-apps/plugin-dialog";
import { commands } from "../ipc/commands";
import type { SwfStepEntry, SwfStepSkill } from "./guardrail.types";
import { DEFAULT_GUARDRAIL_DIRS, HUNT_JSON, proposedSwfSkill, swfSkillsOf } from "./guardrail-config.utils";
import { isSkillFolder, SKILL_FILE } from "./guardrail-paths.utils";

/**
 * What an agent step of the swf pipeline lacks: with `addEntry` its entry in `swf.skills` of hunt.json, for which `name`
 * is then the proposed name, with `missingFile` the skill file of `name`. A step that lacks nothing has no gap.
 */
export type SwfSkillGap = SwfStepSkill & { missingFile: boolean };

/** Worktree-relative path of the skill file of the skill `name`. */
export function swfSkillFile(name: string): string {
  return `${DEFAULT_GUARDRAIL_DIRS.skill}/${name}/${SKILL_FILE}`;
}

/** The skill name the step of `entry` is about: the one its entry sets, else the proposed one. */
export function swfSkillName(entry: SwfStepEntry): string {
  return entry.name ?? proposedSwfSkill(entry.step);
}

/**
 * The gaps of `entries`, in their order: a step without an entry needs one, a step whose skill name is not among
 * `existing` (the names of the skill folders that hold a SKILL.md) needs the file. A missing file several steps share is
 * listed under the first of them only, since Hunt writes it from that step's template.
 */
export function missingSwfSkills(entries: readonly SwfStepEntry[], existing: ReadonlySet<string>): SwfSkillGap[] {
  const names = entries.map(swfSkillName);
  const gaps: SwfSkillGap[] = [];
  entries.forEach((entry, position) => {
    const name = names[position];
    const missingFile = !existing.has(name) && names.indexOf(name) === position;
    if (!entry.name || missingFile) {
      gaps.push({ step: entry.step, name, addEntry: !entry.name, missingFile });
    }
  });
  return gaps;
}

/** The line of the dialog about `gap`: its step and what the step lacks. */
function swfSkillGapLine(gap: SwfSkillGap): string {
  const lacks: string[] = [];
  if (gap.addEntry) {
    lacks.push(`no entry swf.skills.${gap.step} in ${HUNT_JSON} (proposed: ${gap.name})`);
  }
  if (gap.missingFile) {
    lacks.push(`no skill file ${swfSkillFile(gap.name)}`);
  }
  return `• ${gap.step}: ${lacks.join(" and ")}`;
}

/** The question of the dialog that offers to close the `gaps`: one line per step with what it lacks, then what a click on "Create" does. */
export function swfSkillsQuestion(gaps: readonly SwfSkillGap[]): string {
  const addsEntries = gaps.some((gap) => gap.addEntry);
  const createsFiles = gaps.some((gap) => gap.missingFile);
  const actions = [addsEntries ? `add the missing entries to ${HUNT_JSON}` : "", createsFiles ? "create the missing skills from Hunt's templates" : ""];
  const action = actions.filter(Boolean).join(" and ");
  return (
    `This repository uses Hunt's software factory (the swf section of its ${HUNT_JSON}), but not every agent step has its skill:\n\n` +
    gaps.map(swfSkillGapLine).join("\n") +
    `\n\n${action.charAt(0).toUpperCase()}${action.slice(1)}? ` +
    (createsFiles ? "Each template is for the repository to fill in; existing entries and skill files are kept." : "Existing entries and skill files are kept.")
  );
}

/** Worktrees whose user declined the dialog in this run of the app; they are asked again after a restart. */
const declined = new Set<string>();
/** Worktrees with a dialog open right now, so that two sessions of one worktree do not ask twice. */
const pending = new Set<string>();

/**
 * Makes sure a repository that uses Hunt's software factory (its hunt.json has an `swf` section) names a skill for every
 * agent step in `swf.skills` and keeps each skill's file: when an entry or a file is missing, the user is asked once
 * whether to add the entries (under the proposed names) and create the files from Hunt's templates, and on agreement Hunt
 * writes them (existing entries and skill files are never touched). A decline holds until the app restarts. Failures are
 * reported to the console only, because the check is a courtesy on opening a session and must not disturb the chat.
 */
export async function ensureSwfSkills(sessionId: string, worktreePath: string): Promise<void> {
  if (declined.has(worktreePath) || pending.has(worktreePath)) return;
  pending.add(worktreePath);
  try {
    const huntJson = await commands.readFile(sessionId, HUNT_JSON).catch(() => "");
    const entries = swfSkillsOf(huntJson);
    if (!entries) return;
    const gaps = missingSwfSkills(entries, await existingSkills(sessionId, new Set(entries.map(swfSkillName))));
    if (!gaps.length) return;
    const agreed = await ask(swfSkillsQuestion(gaps), { title: "Software factory skills", kind: "info", okLabel: "Create", cancelLabel: "Not now" });
    if (!agreed) {
      declined.add(worktreePath);
      return;
    }
    const skills: SwfStepSkill[] = gaps.map((gap) => ({ step: gap.step, name: gap.name, addEntry: gap.addEntry }));
    await commands.createSwfSkills(sessionId, skills);
  } catch (error) {
    console.error("failed to create the skills of the swf steps:", error);
  } finally {
    pending.delete(worktreePath);
  }
}

/** The `names` whose folder in the worktree's skills directory holds a SKILL.md; none without that directory. */
async function existingSkills(sessionId: string, names: ReadonlySet<string>): Promise<Set<string>> {
  const entries = await commands.listDir(sessionId, DEFAULT_GUARDRAIL_DIRS.skill).catch(() => []);
  const existing = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDir || !names.has(entry.name)) continue;
    if (isSkillFolder(await commands.listDir(sessionId, `${DEFAULT_GUARDRAIL_DIRS.skill}/${entry.name}`))) {
      existing.add(entry.name);
    }
  }
  return existing;
}
