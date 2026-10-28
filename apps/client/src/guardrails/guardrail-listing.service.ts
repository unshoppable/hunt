import { commands } from "../ipc/commands";
import { baseName } from "../common/path/path.utils";
import type { Guardrail, GuardrailDirs, GuardrailListing } from "./guardrail.types";
import { adrDirOf, DEFAULT_GUARDRAIL_DIRS, guardrailSkillOf, HUNT_JSON } from "./guardrail-config.utils";
import { adrGuardrails, agentGuardrails, isGuardrailMarkdown, isSkillFolder, markdownFileNames, ruleGuardrail, skillGuardrail } from "./guardrail-paths.utils";
import { directoriesOfKind, foldersOf, instructionGuardrails } from "./guardrail-tree.utils";

/** The guardrail folders of the session's worktree: Claude Code's fixed ones and the ADR folder of its hunt.json. */
export async function readGuardrailDirs(sessionId: string): Promise<GuardrailDirs> {
  const huntJson = await commands.readFile(sessionId, HUNT_JSON).catch(() => "");
  return { ...DEFAULT_GUARDRAIL_DIRS, adr: adrDirOf(huntJson) };
}

/** The guardrail skill of the session's worktree (see `guardrailSkillOf`). */
export async function readGuardrailSkill(sessionId: string): Promise<string> {
  const huntJson = await commands.readFile(sessionId, HUNT_JSON).catch(() => "");
  return guardrailSkillOf(huntJson);
}

/** Entries of a worktree folder, or none when the folder does not exist. */
async function listDirOrEmpty(sessionId: string, path: string) {
  try {
    return await commands.listDir(sessionId, path);
  } catch {
    return [];
  }
}

/** Guardrail Markdown files below `directory`, recursively, as worktree-relative paths (see `isGuardrailMarkdown`). */
async function markdownFilesBelow(sessionId: string, directory: string): Promise<string[]> {
  const entries = await listDirOrEmpty(sessionId, directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDir) {
      files.push(...(await markdownFilesBelow(sessionId, path)));
    } else if (isGuardrailMarkdown(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** Every project file (tracked and untracked, ignored ones excluded), or none when the worktree cannot be listed. */
async function listFilesOrEmpty(sessionId: string): Promise<string[]> {
  try {
    return await commands.listFiles(sessionId);
  } catch {
    return [];
  }
}

/** Files below `directory` that the worktree's history deleted, or none when the history cannot be read. */
async function listDeletedFilesOrEmpty(sessionId: string, directory: string): Promise<string[]> {
  try {
    return await commands.listDeletedFiles(sessionId, directory);
  } catch {
    return [];
  }
}

/** Reads the instruction files of the session's worktree and its rules, skills, agents and ADRs from its guardrail folders. */
export async function listGuardrails(sessionId: string): Promise<GuardrailListing> {
  const dirs = await readGuardrailDirs(sessionId);
  const [files, agentEntries, adrEntries, deletedAdrs] = await Promise.all([
    listFilesOrEmpty(sessionId),
    listDirOrEmpty(sessionId, dirs.agent),
    listDirOrEmpty(sessionId, dirs.adr),
    listDeletedFilesOrEmpty(sessionId, dirs.adr),
  ]);
  const folders = foldersOf(files);

  const rules: Guardrail[] = [];
  const ruleDirectories: string[] = [];
  for (const directory of directoriesOfKind(dirs.rule, folders)) {
    const ruleFiles = await markdownFilesBelow(sessionId, directory);
    if (!ruleFiles.length) continue;
    ruleDirectories.push(directory);
    rules.push(...ruleFiles.map((path) => ruleGuardrail(directory, path)));
  }

  const skills: Guardrail[] = [];
  const skillDirectories: string[] = [];
  for (const directory of directoriesOfKind(dirs.skill, folders)) {
    const entries = await listDirOrEmpty(sessionId, directory);
    let hasSkill = false;
    for (const entry of entries.filter((entry) => entry.isDir)) {
      if (!isSkillFolder(await listDirOrEmpty(sessionId, `${directory}/${entry.name}`))) continue;
      skills.push(skillGuardrail(directory, entry.name));
      hasSkill = true;
    }
    if (hasSkill) {
      skillDirectories.push(directory);
    }
  }

  return {
    instruction: instructionGuardrails(files),
    rule: rules,
    skill: skills,
    agent: agentGuardrails(dirs.agent, markdownFileNames(agentEntries)),
    adr: adrGuardrails(dirs.adr, markdownFileNames(adrEntries)),
    dirs,
    folders,
    foundDirs: { rule: ruleDirectories, skill: skillDirectories },
    deletedAdrs: deletedAdrs.map(baseName),
  };
}
