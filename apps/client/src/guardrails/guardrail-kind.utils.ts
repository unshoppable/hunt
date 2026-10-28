import type { GuardrailKind, KindHelp } from "./guardrail.types";

/** Every guardrail kind of a listing, in the order of the window's tabs. */
export const KINDS: GuardrailKind[] = ["instruction", "rule", "skill", "agent", "adr"];

/** Tab and button labels of each kind; `item` is the in-sentence form with its article. */
export const KIND_LABELS: Record<GuardrailKind, { singular: string; plural: string; item: string }> = {
  instruction: { singular: "CLAUDE.md", plural: "Instructions", item: "a CLAUDE.md" },
  rule: { singular: "Rule", plural: "Rules", item: "a rule" },
  skill: { singular: "Skill", plural: "Skills", item: "a skill" },
  agent: { singular: "Agent", plural: "Agents", item: "an agent" },
  adr: { singular: "ADR", plural: "Architectural Decision Records", item: "an ADR" },
};

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
