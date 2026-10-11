import { commands } from "../ipc/commands";
import { normalizeGuardrailDir, type GuardrailDirs, type GuardrailKind } from "../state/settings";
import { dirName, splitPath } from "../ui/path";

export type { GuardrailDirs, GuardrailKind } from "../state/settings";

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
  /** The folders (see settings) the listing was read from and new guardrails go into. */
  dirs: GuardrailDirs;
  /** Every folder of the worktree holding a project file (see `foldersOf`), for the instruction tree. */
  folders: string[];
};

export type InstructionRow = { type: "folder"; path: string; name: string; depth: number; hasInstruction: boolean } | { type: "file"; entry: Guardrail; depth: number };

/** Name of the instruction files Claude Code reads on its own, at the root and in any folder. */
const INSTRUCTION_FILE = "CLAUDE.md";

/** Tab and button labels of each kind; `item` is the in-sentence form with its article. */
export const KIND_LABELS: Record<GuardrailKind, { singular: string; plural: string; item: string }> = {
  instruction: { singular: "CLAUDE.md", plural: "Instructions", item: "a CLAUDE.md" },
  rule: { singular: "Rule", plural: "Rules", item: "a rule" },
  skill: { singular: "Skill", plural: "Skills", item: "a skill" },
  agent: { singular: "Agent", plural: "Agents", item: "an agent" },
  adr: { singular: "ADR", plural: "Architectural Decision Records", item: "an ADR" },
};

/** Help popover text of `kind`: what the files are, how Claude Code loads them, and when to use that kind rather than another. */
export type KindHelp = { what: string; loading: string; use: string };

export function kindHelp(kind: GuardrailKind): KindHelp {
  switch (kind) {
    case "instruction":
      return {
        what: "CLAUDE.md files hold the project instructions: how the project is built and tested, its layout and the conventions of the code.",
        loading:
          "The CLAUDE.md at the repository root is read at session start and is part of every turn. A CLAUDE.md in a subfolder is loaded only once Claude reads or edits a file below that folder, so its conventions stay out of context until that part of the code is touched.",
        use: "Use it for what every change must respect. Keep it short, since it is in context all the time; long or situational material belongs in a rule or a skill.",
      };
    case "rule":
      return {
        what: "Rules are Markdown files that extend the project instructions by topic.",
        loading:
          'A rule without a "paths" list in its front matter is loaded together with the project instructions and applies to every turn. With a list (for example paths: ["src/api/**"]) it is loaded only while Claude works on a file matching one of the globs.',
        use: "Use a rule for conventions that concern one part of the code, such as the API layer or the tests, or to split a long CLAUDE.md into topics. Unlike a subfolder CLAUDE.md, a rule matches files anywhere by glob.",
      };
    case "skill":
      return {
        what: "Skills are reusable procedures: a SKILL.md with a name and a description, followed by the steps Claude carries out.",
        loading:
          "Only the name and the description of every skill are in context from the start. The full instructions are loaded when a task matches the description or the user invokes the skill as /name, and they stay for the rest of the turn.",
        use: "Use a skill for a recurring task with several steps, such as a release, a migration or a review checklist. It costs no context until it is needed, so it suits long instructions that a rule would carry on every turn.",
      };
    case "agent":
      return {
        what: "Agents are subagent definitions: a system prompt with name, description and optionally tools and model. A subagent works in a context window of its own and reports back a summary.",
        loading:
          "Every agent is available in every session. Only its name and description are in context, so Claude can decide when to delegate; the system prompt is loaded when the subagent runs. A file added or edited on disk is picked up within seconds. A project agent overrides a user agent of the same name.",
        use: "Use an agent for work that should not fill the main conversation, such as a broad code search or an independent review, or that needs a fixed role with restricted tools or another model. For a procedure Claude follows itself, use a skill.",
      };
    case "adr":
      return {
        what: "Architectural decision records document one decision each: its context, the decision and its consequences.",
        loading:
          "Claude Code does not load ADRs on its own. One reaches Claude only when a CLAUDE.md or a rule refers to it, or when Claude opens the file while exploring the repository. Hunt therefore offers, when a session opens, to add a section to the root CLAUDE.md that names the ADR folder and the ls and grep commands to search it.",
        use: "Write an ADR when a decision shapes the architecture and others would otherwise ask why it was made: a framework, a data model, a boundary between modules. It records the reasoning for the team; it does not instruct Claude.",
      };
  }
}

/** Kinds the "New …" button creates; an instruction file is added to a folder of the tree instead. */
export type CreatableKind = Exclude<GuardrailKind, "instruction">;

/** What a guardrail of `kind` is, as the agent writing the file at `path` is told. */
function kindContent(kind: GuardrailKind, path: string): string {
  const folder = folderOf(path);
  switch (kind) {
    case "instruction":
      return folder
        ? `a CLAUDE.md instruction file that Claude Code loads whenever it works on a file below \`${folder}\`. It should state the conventions, structure and rules of that part of the code.`
        : "the project's root CLAUDE.md, which Claude Code loads on every turn. It should state how the project is built, tested and structured, and the conventions every change must follow.";
    case "rule":
      return "a rule file in Markdown that extends the project instructions. Without a front matter it is loaded on every turn; add a front matter with a `paths:` list of globs only when the rule should apply to part of the code.";
    case "skill":
      return "a SKILL.md: a front matter with `name` and `description` (when to use the skill), then step-by-step instructions the agent follows when the skill is used.";
    case "agent":
      return "a subagent definition: a front matter with `name`, `description` (when to delegate to it) and optionally `tools` and `model`, then the system prompt of the subagent.";
    case "adr":
      return "an architectural decision record with the sections Context, Decision and Consequences; keep the heading's number and the date.";
  }
}

/** The size rule every generated guardrail follows: it is in context whenever it is loaded. */
const CONTEXT_RULE =
  "The file costs context whenever it is loaded: write it as short as possible and as long as necessary, in concise Markdown, without filler, repetition or anything Claude knows anyway.";

/** What the agent of the "Agent" button is asked to do for the file at `path`: write it as a guardrail of `kind`. */
export function generationTask(kind: GuardrailKind, path: string): string {
  return `Write the content of \`${path}\`: ${kindContent(kind, path)} Base it on what you find in the repository and on the user's messages, which say what the file should contain. Replace the file's current content with the result using your file-editing tools and answer with a short summary of what you wrote. ${CONTEXT_RULE}`;
}

/**
 * What the agent of the "New …" button is asked to do: create a guardrail of `kind` in the listing's folder under a
 * name it chooses from the user's messages, so that a later agent finds the file by its name. `today` dates an ADR.
 */
export function creationTask(kind: CreatableKind, listing: GuardrailListing, today = new Date()): string {
  const dir = listing.dirs[kind];
  const location = (() => {
    switch (kind) {
      case "rule":
        return `\`${dir}/<name>.md\`, or in a subfolder of \`${dir}\` when the existing rules are grouped by topic`;
      case "skill":
        return `\`${dir}/<name>/SKILL.md\``;
      case "agent":
        return `\`${dir}/<name>.md\``;
      case "adr":
        return `\`${dir}/${String(nextAdrNumber(listing.adr)).padStart(4, "0")}-<name>.md\`; the heading starts with the number ${nextAdrNumber(listing.adr)} and the record is dated ${today.toISOString().slice(0, 10)}`;
    }
  })();
  return `Create ${kindContent(kind, "")} Put it at ${location}. Choose <name> yourself: a short kebab-case name that says what the file is about, so that an agent finds the file later by its name alone; look at the existing files in \`${dir}\` and follow their naming, and never overwrite one of them. Base the content on what you find in the repository and on the user's messages, which say what the file should contain. Write the file with your file-editing tools and answer with the path you chose and a short summary of what you wrote. ${CONTEXT_RULE}`;
}

/** Whether `path` is an instruction file: `CLAUDE.md` at the root or in any folder. */
function isInstructionFile(path: string): boolean {
  return path === INSTRUCTION_FILE || path.endsWith(`/${INSTRUCTION_FILE}`);
}

/** The folder of a worktree-relative path, `""` for a file at the root. */
export function folderOf(path: string): string {
  return dirName(path);
}

/** Every folder (and folder of a folder) of the given files, sorted; the root itself is left out. */
export function foldersOf(files: string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    for (let folder = folderOf(file); folder; folder = folderOf(folder)) {
      folders.add(folder);
    }
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}

/** The folders the instruction tree starts out open: the root and every folder on the way to a CLAUDE.md. */
export function expandedForInstructions(instructions: Guardrail[]): Set<string> {
  const expanded = new Set([""]);
  for (const entry of instructions) {
    for (let folder = folderOf(entry.path); folder; folder = folderOf(folder)) {
      expanded.add(folder);
    }
  }
  return expanded;
}

/**
 * The rows of the instruction tree: the root (shown as `projectName`), then below each open folder its subfolders by
 * name and, last, its own CLAUDE.md. A closed folder hides everything below it.
 */
export function instructionTreeRows(folders: string[], instructions: Guardrail[], expanded: ReadonlySet<string>, projectName: string): InstructionRow[] {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    const parent = folderOf(folder);
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const byFolder = new Map(instructions.map((entry) => [folderOf(entry.path), entry]));

  const rows: InstructionRow[] = [];
  const walk = (folder: string, name: string, depth: number) => {
    rows.push({ type: "folder", path: folder, name, depth, hasInstruction: byFolder.has(folder) });
    if (!expanded.has(folder)) return;
    for (const child of children.get(folder) ?? []) {
      walk(child, child.slice(folder ? folder.length + 1 : 0), depth + 1);
    }
    const own = byFolder.get(folder);
    if (own) {
      rows.push({ type: "file", entry: own, depth: depth + 1 });
    }
  };
  walk("", projectName, 0);
  return rows;
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

/** The number for the next ADR: one more than the highest existing one, starting at 1. */
export function nextAdrNumber(existing: Guardrail[]): number {
  const highest = Math.max(0, ...existing.map((adr) => adrNumber(adr.name) ?? 0));
  return highest + 1;
}

/**
 * Path of a new guardrail named `title` in the listing's folders, null when `title` yields no usable file name. For
 * an instruction file `title` is the folder it goes into (empty for the repository root); the existing ADRs decide
 * the ADR's number.
 */
export function guardrailPath(kind: GuardrailKind, title: string, listing: GuardrailListing): string | null {
  if (kind === "instruction") {
    if (!title.trim()) return INSTRUCTION_FILE;
    const dir = normalizeGuardrailDir(title);
    return dir ? `${dir}/${INSTRUCTION_FILE}` : null;
  }
  const slug = slugify(title);
  if (!slug) return null;
  switch (kind) {
    case "rule":
      return `${listing.dirs.rule}/${slug}.md`;
    case "skill":
      return `${listing.dirs.skill}/${slug}/SKILL.md`;
    case "agent":
      return `${listing.dirs.agent}/${slug}.md`;
    case "adr":
      return `${listing.dirs.adr}/${String(nextAdrNumber(listing.adr)).padStart(4, "0")}-${slug}.md`;
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
      return `# ${nextAdrNumber(listing.adr)}. ${heading}\n\nDate: ${today.toISOString().slice(0, 10)}\n\n## Context\n\n\n## Decision\n\n\n## Consequences\n\n`;
  }
}

/** Whether `path` lies below `folder` (`""` is the root, which holds everything). */
export function isInsideFolder(path: string, folder: string): boolean {
  return !folder || path.startsWith(`${folder}/`);
}

/** What deleting `entry` removes: a skill's whole folder, otherwise the file itself. */
export function guardrailDeleteTarget(entry: Guardrail): string {
  return entry.kind === "skill" ? entry.path.slice(0, -"/SKILL.md".length) : entry.path;
}

/**
 * The rows of the list: entries grouped under their folders, folders sorted by name and placed before the loose
 * entries of their level (which keep their order); the rows below a folder in `collapsed` are left out.
 */
export function guardrailListRows(entries: Guardrail[], collapsed: ReadonlySet<string> = new Set()): GuardrailListRow[] {
  type Node = { folders: Map<string, Node>; entries: Guardrail[] };
  const root: Node = { folders: new Map(), entries: [] };
  for (const entry of entries) {
    let node = root;
    for (const segment of entry.folder ? entry.folder.split("/") : []) {
      let child = node.folders.get(segment);
      if (!child) {
        child = { folders: new Map(), entries: [] };
        node.folders.set(segment, child);
      }
      node = child;
    }
    node.entries.push(entry);
  }

  const rows: GuardrailListRow[] = [];
  const walk = (node: Node, folder: string, depth: number) => {
    const names = [...node.folders.keys()].sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const path = folder ? `${folder}/${name}` : name;
      rows.push({ type: "folder", folder: path, name, depth });
      if (!collapsed.has(path)) {
        walk(node.folders.get(name)!, path, depth + 1);
      }
    }
    for (const entry of node.entries) {
      rows.push({ type: "entry", entry, depth });
    }
  };
  walk(root, "", 0);
  return rows;
}

/** Entries of a worktree folder, or none when the folder does not exist. */
async function listDirOrEmpty(sessionId: string, path: string) {
  try {
    return await commands.listDir(sessionId, path);
  } catch {
    return [];
  }
}

/** The Markdown files among a folder's entries, a README excluded. */
function markdownEntries<T extends { name: string; isDir: boolean }>(entries: T[]): T[] {
  return entries.filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md");
}

/** Markdown files below `dir`, recursively, as worktree-relative paths. */
async function markdownFilesBelow(sessionId: string, dir: string): Promise<string[]> {
  const entries = await listDirOrEmpty(sessionId, dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDir) {
      files.push(...(await markdownFilesBelow(sessionId, path)));
    } else if (entry.name.toLowerCase().endsWith(".md")) {
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

/** Reads the instruction files of the session's worktree and its rules, skills, agents and ADRs from the folders in `dirs`. */
export async function listGuardrails(sessionId: string, dirs: GuardrailDirs): Promise<GuardrailListing> {
  const [files, ruleFiles, skillEntries, agentEntries, adrEntries] = await Promise.all([
    listFilesOrEmpty(sessionId),
    markdownFilesBelow(sessionId, dirs.rule),
    listDirOrEmpty(sessionId, dirs.skill),
    listDirOrEmpty(sessionId, dirs.agent),
    listDirOrEmpty(sessionId, dirs.adr),
  ]);
  // Shallow files first, so the root CLAUDE.md leads the list.
  const instructions: Guardrail[] = files.filter(isInstructionFile).map((path) => ({ kind: "instruction", path, name: INSTRUCTION_FILE, folder: folderOf(path) }));
  instructions.sort((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path));
  const rules: Guardrail[] = ruleFiles.map((path) => {
    const { dir: folder, name } = splitPath(path.slice(dirs.rule.length + 1, -3));
    return { kind: "rule", path, name, folder };
  });

  const skills: Guardrail[] = [];
  for (const entry of skillEntries.filter((entry) => entry.isDir)) {
    const files = await listDirOrEmpty(sessionId, `${dirs.skill}/${entry.name}`);
    if (!files.some((file) => file.name === "SKILL.md")) continue;
    skills.push({ kind: "skill", path: `${dirs.skill}/${entry.name}/SKILL.md`, name: entry.name, folder: "" });
  }

  const agents: Guardrail[] = markdownEntries(agentEntries).map((entry) => ({ kind: "agent", path: `${dirs.agent}/${entry.name}`, name: entry.name.slice(0, -3), folder: "" }));
  agents.sort((left, right) => left.name.localeCompare(right.name));

  const adrs: Guardrail[] = markdownEntries(adrEntries).map((entry) => ({ kind: "adr", path: `${dirs.adr}/${entry.name}`, name: entry.name.slice(0, -3), folder: "" }));
  adrs.sort((left, right) => (adrNumber(right.name) ?? 0) - (adrNumber(left.name) ?? 0) || left.name.localeCompare(right.name));

  return { instruction: instructions, rule: rules, skill: skills, agent: agents, adr: adrs, dirs, folders: foldersOf(files) };
}
