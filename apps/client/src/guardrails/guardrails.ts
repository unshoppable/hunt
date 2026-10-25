import { commands } from "../ipc/commands";
import { baseName, dirName, isInsideFolder, splitPath } from "../ui/path";

/** The kinds of guardrail that live in a folder of their own. */
export type GuardrailDirKind = "rule" | "skill" | "agent" | "adr";

/** The kinds of guardrail the guardrails window manages: `CLAUDE.md` instruction files anywhere in the worktree plus the folder-based kinds. */
export type GuardrailKind = "instruction" | GuardrailDirKind;

/** Worktree-relative folders the guardrails window reads and writes each folder-based kind in, without a trailing slash. */
export type GuardrailDirs = Record<GuardrailDirKind, string>;

/**
 * The folders of a repository whose hunt.json sets no `adrDir`: Claude Code reads rules, skills and subagents only from
 * these, while ADRs have no fixed place and go among the files Claude Code never loads on its own.
 */
export const DEFAULT_GUARDRAIL_DIRS: GuardrailDirs = { rule: ".claude/rules", skill: ".claude/skills", agent: ".claude/agents", adr: ".claude/resources/adrs" };

/** The repository's Hunt configuration, whose optional `adrDir` names the ADR folder. */
const HUNT_JSON = "hunt.json";

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

/** The guardrail folders of the session's worktree: Claude Code's fixed ones and the ADR folder of its hunt.json. */
export async function readGuardrailDirs(sessionId: string): Promise<GuardrailDirs> {
  const huntJson = await commands.readFile(sessionId, HUNT_JSON).catch(() => "");
  return { ...DEFAULT_GUARDRAIL_DIRS, adr: adrDirOf(huntJson) };
}

/** The guardrail skill of a repository whose hunt.json sets no `guardrailSkill` (`DEFAULT_SKILL` in `src-tauri/src/guardrail_skill.rs`). */
export const DEFAULT_GUARDRAIL_SKILL = "guardrail";
/** A skill name as Claude Code accepts it: kebab-case of letters and digits, at most 64 characters. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The guardrail skill the text of a hunt.json sets as `guardrailSkill`: the skill at `.claude/skills/<name>/SKILL.md`
 * the "Guardrail" button invokes; the default without one or for an unreadable file or value.
 */
export function guardrailSkillOf(huntJson: string): string {
  try {
    const skill: unknown = JSON.parse(huntJson)?.guardrailSkill;
    return typeof skill === "string" && skill.length <= 64 && SKILL_NAME.test(skill) ? skill : DEFAULT_GUARDRAIL_SKILL;
  } catch {
    return DEFAULT_GUARDRAIL_SKILL;
  }
}

/** The guardrail skill of the session's worktree (see `guardrailSkillOf`). */
export async function readGuardrailSkill(sessionId: string): Promise<string> {
  const huntJson = await commands.readFile(sessionId, HUNT_JSON).catch(() => "");
  return guardrailSkillOf(huntJson);
}

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
        use: "Use a rule for conventions that concern one part of the code, such as the API layer or the tests, or to split a long CLAUDE.md into topics. Unlike a subfolder CLAUDE.md, a rule matches files anywhere by glob. A rule tells Claude what to do when it writes code there; when it follows from an architectural decision, it names that decision (or its ADR) as the reason in one sentence.",
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
        use: "Write an ADR only for a decision that still binds future changes, that the code does not show or that looks wrong without its reason, that someone would otherwise \"fix\" or question again, and that affects more than one place; a decision about one place is a comment in the code there. It records why one alternative was chosen over the others; it does not instruct Claude. A coding convention that follows from the decision belongs in a rule that refers to the ADR.",
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
      return "an architectural decision record with the sections Context, Decision and Consequences; keep the heading's number and the date. When it replaces an earlier ADR, its Context names that one by number and title and says why its reason no longer holds, and the earlier file is deleted.";
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
 * What the agent of the page of a new file is asked to do: create a guardrail of `kind` in the listing's folder,
 * named after `name` or, when that is blank, under a name it chooses from the user's messages, so that a later agent
 * finds the file by its name. `location` is the directory the file goes into (by default the kind's configured one)
 * and, for a rule, the folder below it; for a CLAUDE.md it is the folder the file belongs to, which fixes the name.
 * `today` dates an ADR.
 */
export function creationTask(kind: GuardrailKind, listing: GuardrailListing, name = "", location: Partial<GuardrailLocation> = {}, today = new Date()): string {
  if (kind === "instruction") {
    const path = location.dir ? `${location.dir}/${INSTRUCTION_FILE}` : INSTRUCTION_FILE;
    return `Create ${kindContent(kind, path)} Put it at \`${path}\`. Base the content on what you find in the repository and on the user's messages, which say what the file should contain. Write the file with your file-editing tools and answer with a short summary of what you wrote. ${CONTEXT_RULE}`;
  }
  const dir = location.dir ?? listing.dirs[kind];
  const folder = location.folder ?? "";
  const slug = slugify(name);
  const place = placeOf(kind, listing, slug || "<name>", { dir, folder }, today);
  const naming = slug
    ? `The user chose the name \`${slug}\`; never overwrite an existing file in \`${dir}\`.`
    : `Choose <name> yourself: a short kebab-case name that says what the file is about, so that an agent finds the file later by its name alone; look at the existing files in \`${dir}\` and follow their naming, and never overwrite one of them.`;
  const owner = ownerFolderOf(dir, listing.dirs[kind]);
  const scope = owner ? ` The directory belongs to \`${owner}\`: Claude Code loads the file once it works on a file below that folder.` : "";
  return `Create ${kindContent(kind, "")} Put it at ${place}.${scope} ${naming} Base the content on what you find in the repository and on the user's messages, which say what the file should contain. Write the file with your file-editing tools and answer with the path you chose and a short summary of what you wrote. ${CONTEXT_RULE}`;
}

/** Where a new guardrail of `kind` named `file` goes, as the agent creating it is told; an ADR's place also names its number and date. */
function placeOf(kind: CreatableKind, listing: GuardrailListing, file: string, { dir, folder }: GuardrailLocation, today: Date): string {
  switch (kind) {
    case "rule":
      return folder ? `\`${dir}/${folder}/${file}.md\`` : `\`${dir}/${file}.md\`, or in a subfolder of \`${dir}\` when the existing rules are grouped by topic`;
    case "skill":
      return `\`${dir}/${file}/SKILL.md\``;
    case "agent":
      return `\`${dir}/${file}.md\``;
    case "adr":
      return `\`${dir}/${String(nextAdrNumber(listing.adr, listing.deletedAdrs)).padStart(4, "0")}-${file}.md\`; the heading starts with the number ${nextAdrNumber(listing.adr, listing.deletedAdrs)} and the record is dated ${today.toISOString().slice(0, 10)}`;
  }
}

/** Selection path of the "New" button's chat: it names no file, so no file content comes with the user's messages. */
export const GUARDRAIL_CHAT_PATH = ".claude";

/**
 * What the agent of the "New" button is asked to do: turn the user's description into the guardrail kind that fits
 * (instruction, rule, skill, agent or ADR) and write it where it belongs; while the kind, the content or the scope is
 * unclear, it asks the user instead of writing. `today` dates an ADR. Wherever existing guardrails are checked, cover
 * all five kinds (CLAUDE.md, rules, skills, agents, ADRs), never a subset.
 */
export function guardrailTask(listing: GuardrailListing, today = new Date()): string {
  const creatable: CreatableKind[] = ["rule", "skill", "agent", "adr"];
  const kinds = [
    `- Instruction: a \`CLAUDE.md\` at the repository root, or in the folder whose code it concerns. ${kindHelp("instruction").use} Add to the existing CLAUDE.md of that folder rather than creating a second one.`,
    ...creatable.map((kind) => `- ${KIND_LABELS[kind].singular}: ${kindContent(kind, "")} Put it at ${placeOf(kind, listing, "<name>", { dir: listing.dirs[kind], folder: "" }, today)}. ${kindHelp(kind).use}`),
  ];
  return [
    "The user describes a guardrail for this repository. Turn the description into exactly one guardrail of the kind that fits and write it where it belongs:",
    ...kinds,
    "Decide the kind from the user's message and from the repository. When the message leaves open which kind fits, what the guardrail should say or which part of the code it applies to, write nothing yet: ask one short question, naming the kinds in question with one sentence on how they differ, and continue once the user answered.",
    "Before writing, read the existing files of that kind and follow their naming and structure. Extend an existing file when the request belongs there instead of adding a duplicate, and never overwrite or delete other content except an ADR the new one replaces. When a guardrail of any kind already says what the user asks for, write nothing and name that file instead. Choose <name> as a short kebab-case name that says what the file is about, so that an agent finds the file by its name alone.",
    `Write the file with your file-editing tools and answer with the kind you chose, the path and a short summary of what you wrote. ${CONTEXT_RULE}`,
  ].join("\n");
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

/** The folder row of the tree an entry is listed under: its own folder; for a skill the folder holding the skill folders. */
export function treeParentOf(entry: Guardrail): string {
  return entry.kind === "skill" ? folderOf(folderOf(entry.path)) : folderOf(entry.path);
}

/** Whether `folder` is `dir` itself or lies below it. */
function isAtOrBelow(folder: string, dir: string): boolean {
  return folder === dir || isInsideFolder(folder, dir);
}

/**
 * The folder (`""` for the root) whose `.claude` holds `dir`, which is `kindDir` (the configured `.claude/rules`)
 * at the root or below a folder; null when `dir` is not such a directory.
 */
export function ownerFolderOf(dir: string, kindDir: string): string | null {
  if (dir === kindDir) return "";
  return dir.endsWith(`/${kindDir}`) ? dir.slice(0, -kindDir.length - 1) : null;
}

/** Where a new guardrail goes: its kind's directory and, for a rule, the folder below it. */
export type GuardrailLocation = { dir: string; folder: string };

/**
 * The folder whose kind directory `folder` is on the way to, when `folder` is a container of the kind directory
 * `kindDir` (`.claude` or `src/api/.claude` for `.claude/rules`): `""` for the root, null when it is no container.
 */
function containerOwnerOf(folder: string, kindDir: string): string | null {
  const segments = kindDir.split("/");
  for (let count = segments.length - 1; count > 0; count--) {
    const prefix = segments.slice(0, count).join("/");
    if (folder === prefix) return "";
    if (folder.endsWith(`/${prefix}`)) return folder.slice(0, -prefix.length - 1);
  }
  return null;
}

/** The kind directory `kindDir` of `owner` (`""` for the root). */
function kindDirOf(owner: string, kindDir: string): string {
  return owner ? `${owner}/${kindDir}` : kindDir;
}

/**
 * Where the "+" of the tree folder `folder` creates a file of `kind`: inside the kind's directory the folder is or
 * lies in, in the directory a container (`.claude`) leads to, otherwise in a new `<folder>/<kind dir>` (which
 * Claude Code loads once it works in that folder).
 */
export function newGuardrailLocation(kind: TreeDirKind, folder: string, listing: GuardrailListing): GuardrailLocation {
  const dir = listing.foundDirs[kind].find((candidate) => isAtOrBelow(folder, candidate));
  if (dir) return { dir, folder: folder === dir ? "" : folder.slice(dir.length + 1) };
  const owner = containerOwnerOf(folder, listing.dirs[kind]) ?? folder;
  return { dir: kindDirOf(owner, listing.dirs[kind]), folder: "" };
}

/**
 * The folders of the tree of `kind`: the worktree's folders and every folder on the way to one of the kind's
 * directories (so that a git-ignored `.claude` still shows). A container (`.claude`) shows only when it holds one
 * of the kind's directories, and inside it only that directory; the folders of a skill are left out since the
 * skill itself is the entry.
 */
export function treeFolders(kind: GuardrailKind, listing: GuardrailListing): string[] {
  const folders = new Set(listing.folders);
  if (kind !== "rule" && kind !== "skill") return [...folders];
  const kindDir = listing.dirs[kind];
  const dirs = listing.foundDirs[kind];
  for (const dir of dirs) {
    for (let folder = dir; folder; folder = folderOf(folder)) {
      folders.add(folder);
    }
  }
  const isHidden = (folder: string) => {
    if (kind === "skill" && dirs.some((dir) => isInsideFolder(folder, dir))) return true;
    for (let candidate = folder; candidate; candidate = folderOf(candidate)) {
      const owner = containerOwnerOf(candidate, kindDir);
      if (owner === null) continue;
      const own = kindDirOf(owner, kindDir);
      return !dirs.includes(own) || (candidate !== folder && !isAtOrBelow(folder, own));
    }
    return false;
  };
  return [...folders].filter((folder) => !isHidden(folder)).sort((left, right) => left.localeCompare(right));
}

/** The folders a tree starts out open: the root and every folder on the way to an entry or to one of `dirs`, those included. */
export function expandedForTree(entries: Guardrail[], dirs: string[] = []): Set<string> {
  const expanded = new Set([""]);
  for (const start of [...entries.map(treeParentOf), ...dirs]) {
    for (let folder = start; folder; folder = folderOf(folder)) {
      expanded.add(folder);
    }
  }
  return expanded;
}

/**
 * The rows of a tree: the root (shown as `projectName`), then below each open folder its subfolders by name and,
 * last, the entries listed under it (see `treeParentOf`). A closed folder hides everything below it; a folder row
 * tells whether entries lie anywhere below it, so that empty branches can be set off.
 */
export function guardrailTreeRows(folders: string[], entries: Guardrail[], expanded: ReadonlySet<string>, projectName: string): TreeRow[] {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    const parent = folderOf(folder);
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const byFolder = new Map<string, Guardrail[]>();
  const holding = new Set<string>();
  for (const entry of entries) {
    const parent = treeParentOf(entry);
    byFolder.set(parent, [...(byFolder.get(parent) ?? []), entry]);
    for (let folder = parent; folder; folder = folderOf(folder)) {
      holding.add(folder);
    }
  }

  const rows: TreeRow[] = [];
  const walk = (folder: string, name: string, depth: number) => {
    rows.push({ type: "folder", path: folder, name, depth, hasEntry: byFolder.has(folder), holdsEntries: !folder || holding.has(folder) });
    if (!expanded.has(folder)) return;
    for (const child of children.get(folder) ?? []) {
      walk(child, child.slice(folder ? folder.length + 1 : 0), depth + 1);
    }
    for (const entry of byFolder.get(folder) ?? []) {
      rows.push({ type: "file", entry, depth: depth + 1 });
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
    const dir = normalizeGuardrailDir(title);
    return dir ? `${dir}/${INSTRUCTION_FILE}` : null;
  }
  const slug = slugify(title);
  if (!slug) return null;
  const dir = location.dir ?? listing.dirs[kind];
  const folder = location.folder ?? "";
  switch (kind) {
    case "rule":
      return `${dir}/${folder ? `${folder}/` : ""}${slug}.md`;
    case "skill":
      return `${dir}/${slug}/SKILL.md`;
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
  return entry.kind === "skill" ? entry.path.slice(0, -"/SKILL.md".length) : entry.path;
}

/**
 * The rows of the list: entries grouped under their folders, folders sorted by name and placed before the loose
 * entries of their level (which keep their order); the rows below a folder in `collapsed` are left out.
 */
export function guardrailListRows(entries: Guardrail[], collapsed: ReadonlySet<string> = new Set()): GuardrailListRow[] {
  type Node = { folders: Map<string, Node>; entries: Guardrail[] };
  const root: Node = { folders: new Map(), entries: [] };
  const nodeOf = (folder: string): Node => {
    let node = root;
    for (const segment of folder ? folder.split("/") : []) {
      let child = node.folders.get(segment);
      if (!child) {
        child = { folders: new Map(), entries: [] };
        node.folders.set(segment, child);
      }
      node = child;
    }
    return node;
  };
  for (const entry of entries) {
    nodeOf(entry.folder).entries.push(entry);
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

/** Markdown files below `dir`, recursively, as worktree-relative paths; READMEs excluded. */
async function markdownFilesBelow(sessionId: string, dir: string): Promise<string[]> {
  const entries = await listDirOrEmpty(sessionId, dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDir) {
      files.push(...(await markdownFilesBelow(sessionId, path)));
    } else if (entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
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

/** Files below `dir` that the worktree's history deleted, or none when the history cannot be read. */
async function listDeletedFilesOrEmpty(sessionId: string, dir: string): Promise<string[]> {
  try {
    return await commands.listDeletedFiles(sessionId, dir);
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
  // The configured directory at the root is always read; deeper ones are those the project files reveal.
  const dirsOfKind = (dir: string) => [dir, ...folders.filter((folder) => folder.endsWith(`/${dir}`))];

  // Shallow files first, so the root CLAUDE.md leads the list.
  const instructions: Guardrail[] = files.filter(isInstructionFile).map((path) => ({ kind: "instruction", path, name: INSTRUCTION_FILE, folder: folderOf(path) }));
  instructions.sort((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path));

  const rules: Guardrail[] = [];
  const ruleDirs: string[] = [];
  for (const dir of dirsOfKind(dirs.rule)) {
    const files = await markdownFilesBelow(sessionId, dir);
    if (!files.length) continue;
    ruleDirs.push(dir);
    for (const path of files) {
      const { dir: folder, name } = splitPath(path.slice(dir.length + 1, -3));
      rules.push({ kind: "rule", path, name, folder });
    }
  }

  const skills: Guardrail[] = [];
  const skillDirs: string[] = [];
  for (const dir of dirsOfKind(dirs.skill)) {
    const entries = await listDirOrEmpty(sessionId, dir);
    let hasSkill = false;
    for (const entry of entries.filter((entry) => entry.isDir)) {
      const files = await listDirOrEmpty(sessionId, `${dir}/${entry.name}`);
      if (!files.some((file) => file.name === "SKILL.md")) continue;
      skills.push({ kind: "skill", path: `${dir}/${entry.name}/SKILL.md`, name: entry.name, folder: "" });
      hasSkill = true;
    }
    if (hasSkill) {
      skillDirs.push(dir);
    }
  }

  const agents: Guardrail[] = markdownEntries(agentEntries).map((entry) => ({ kind: "agent", path: `${dirs.agent}/${entry.name}`, name: entry.name.slice(0, -3), folder: "" }));
  agents.sort((left, right) => left.name.localeCompare(right.name));

  const adrs: Guardrail[] = markdownEntries(adrEntries).map((entry) => ({ kind: "adr", path: `${dirs.adr}/${entry.name}`, name: entry.name.slice(0, -3), folder: "" }));
  adrs.sort((left, right) => (adrNumber(right.name) ?? 0) - (adrNumber(left.name) ?? 0) || left.name.localeCompare(right.name));

  return {
    instruction: instructions,
    rule: rules,
    skill: skills,
    agent: agents,
    adr: adrs,
    dirs,
    folders,
    foundDirs: { rule: ruleDirs, skill: skillDirs },
    deletedAdrs: deletedAdrs.map(baseName),
  };
}
