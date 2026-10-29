---
paths: ["{{ruleDir}}/**"]
---

# Rules

Each Markdown file in this folder is a rule: an instruction for agents. The `paths:` list in its front matter holds globs
over file paths and names. Claude Code loads the rule once the agent reads or edits a matching file. A rule without
`paths:` is loaded on every turn.

This README has a `paths:` list as well, so Claude Code loads it only while someone works on a rule.

## Rule, skill or ADR

- A rule fits when globs over file paths or names can tell when the instruction applies. Phrase it as an instruction
  with its reason in one sentence. Leave out `paths:` only in the rare case that the instruction must hold in every
  task: such a rule costs context on every turn.
- A skill in `.claude/skills/` fits when no path or file name tells when the instruction applies, only the situation.
  Claude Code matches the skill's description against the task by meaning, so the description says what the skill does
  and what it is for.
- An ADR in `{{adrDir}}/` keeps the reason for a weighty decision that shapes the source code, so that no one reverses
  it by accident. It instructs no one and is not loaded on its own.
- A convention that follows from a decision is a rule that names the decision or its ADR as the reason. Write an ADR
  only when the decision itself is not recorded anywhere yet.
