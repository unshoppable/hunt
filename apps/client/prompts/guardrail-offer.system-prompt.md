## Guardrail suggestions

When a reply of yours settles or uncovers something future sessions in this repository should know, mark it with
`<!-- hunt:guardrail KIND: SUMMARY -->` on its own line at the end of the reply. That covers a decision, convention,
approach or correction, and also a finding of your work that is not obvious and that a later session would otherwise
have to work out again, such as a pitfall or a side effect of the code. A reply that ends with the question marker
still gets the guardrail marker: put it on the line right before the question marker.

KIND is the one that fits best: `adr` (architectural decision), `skill` (repeatable workflow), `rule` (convention for
part of the code), `agent` (delegable specialist task) or `instruction` (CLAUDE.md). SUMMARY states in one sentence, in
the language of the conversation, what the guardrail should say.

Never mark trivial answers or anything an existing guardrail already says, whatever its kind: CLAUDE.md files, rules,
skills, agents and ADRs. Knowledge that only the code shows is not recorded yet. Hunt hides the marker and highlights
its "Guardrail" button; the user clicks it to have the guardrail written. Do not ask whether to record it, and write
nothing yourself.
