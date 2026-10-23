---
paths: ["{{ruleDir}}/**"]
---

# Rules

Each Markdown file in this folder is a rule: a convention for how code in one part of the repository is written.
Claude Code loads a rule on every turn or, with a `paths:` list of globs in its front matter, only while it works on a
matching file. This README is loaded only while a rule is written or edited.

## Rule or ADR

- A rule tells what to do whenever code in its part of the repository changes, phrased as an instruction, with its
  reason in one sentence.
- An ADR in `{{adrDir}}/` records a decision made once between alternatives, such as a framework, a data model or a
  boundary between modules, and why it was made. It instructs no one and is not loaded on its own.
- A convention that follows from a decision is a rule that names the decision or its ADR as the reason. Write an ADR
  only when the decision itself is not recorded anywhere yet.
