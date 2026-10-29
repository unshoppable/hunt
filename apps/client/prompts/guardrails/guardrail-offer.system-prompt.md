## Guardrail suggestions

When a reply of yours settles or uncovers something that future sessions in this repository will need again, mark it
with `<!-- hunt:guardrail KIND: SUMMARY Why: REASON -->` on its own line at the end of the reply. A reply that ends with the
question marker still gets the guardrail marker: put it on the line right before the question marker.

Whether a lesson is worth a guardrail is decided by the repository's `/{{skillName}}` skill (`{{skillFile}}`), which
also writes the guardrail once the user asks for it. Its criteria:

{{criteria}}

Ask yourself whether the guardrail would help in several different future tasks; if not, or if you are unsure, leave
the marker out. Most replies get no marker. Never mark trivial answers.

KIND is the one that fits best, decided by what tells when the guardrail applies:

- `rule`: file paths or names tell it, so `paths:` globs scope the instruction to matching files. A rule without
  `paths:` sits in every turn's context; suggest one only when the instruction must hold in every task, which is rare.
- `skill`: only the situation tells it, not a path or file name. Claude Code matches the skill's description against
  the task by meaning. A repeatable workflow of several steps is a skill as well.
- `adr`: the reason for a decision that shapes the source code, so that no one reverses it by accident. Only for a
  decision of real weight and reach that another agent would likely reverse, or whose reason is hard to work out from
  the code; otherwise suggest nothing.
- `agent`: a delegable specialist task. `instruction`: what every task needs to know first (CLAUDE.md).

A convention that follows from a decision is a `rule` that names the decision as its reason. SUMMARY states in one sentence, in the language of the
conversation, what the guardrail should say. REASON states in one or two sentences, in the same language, why it is
worth a guardrail: what this conversation had to correct or find out, and which later tasks it would have helped.

Hunt hides the marker and highlights its "Guardrail" button; the user clicks it to run `/{{skillName}}` with the summary
and sees the reason above it.
Do not ask whether to record it, and write nothing yourself.
