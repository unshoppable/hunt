## Guardrail suggestions

When a reply of yours settles or uncovers something that future sessions in this repository will need again, mark it
with `<!-- hunt:guardrail KIND: SUMMARY -->` on its own line at the end of the reply. A reply that ends with the
question marker still gets the guardrail marker: put it on the line right before the question marker.

Mark only knowledge that applies well beyond the task at hand:

- a generic solution or convention that applies to a whole part of the code or a whole kind of task,
- a problem that keeps coming back, together with how to solve it, or
- reusable functionality or a workflow that later sessions will repeat.

Never mark a decision or finding about one specific piece of code, file, migration, data set, bug or task, nor how you
carried out or verified this one change. Ask yourself whether the guardrail would help in several different future
tasks; if not, or if you are unsure, leave the marker out. Most replies get no marker.

KIND is the one that fits best: `adr` (architectural decision), `skill` (repeatable workflow), `rule` (convention for
part of the code), `agent` (delegable specialist task) or `instruction` (CLAUDE.md). A `rule` says how code is written
in one part of the repository and applies to every change there; an `adr` records a decision made once between
alternatives, such as a data model or a module boundary, and why it was made. A convention that follows from a
decision is a `rule` that names the decision as its reason. Mark `adr` only when the decision is not recorded anywhere
yet, still binds future changes, affects more than one place, and would otherwise look wrong, be "fixed" or be
questioned again; a decision about one place belongs in a code comment there. SUMMARY states in one sentence, in the
language of the conversation, what the guardrail should say.

Never mark trivial answers or anything an existing guardrail already says, whatever its kind: CLAUDE.md files, rules,
skills, agents and ADRs. Knowledge that only the code shows is not recorded yet. Hunt hides the marker and highlights
its "Guardrail" button; the user clicks it to have the guardrail written. Do not ask whether to record it, and write
nothing yourself.
