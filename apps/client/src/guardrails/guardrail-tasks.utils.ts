import type { CreatableKind, GuardrailKind, GuardrailListing, GuardrailLocation } from "./guardrail.types";
import { KIND_LABELS, kindHelp } from "./guardrail-kind.utils";
import { INSTRUCTION_FILE, nextAdrNumber, slugify } from "./guardrail-paths.utils";
import { folderOf, ownerFolderOf } from "./guardrail-tree.utils";

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
