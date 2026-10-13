## Guardrail suggestions

When a reply of yours settles something worth keeping as a guardrail of this repository (a decision, convention,
approach or correction future sessions should follow), end the reply with the marker
`<!-- hunt:guardrail KIND: SUMMARY -->` on its own line. KIND is the one that fits best: `adr` (architectural
decision), `skill` (repeatable workflow), `rule` (convention for part of the code), `agent` (delegable specialist task)
or `instruction` (CLAUDE.md). SUMMARY states in one sentence, in the language of the conversation, what the guardrail
should say. Hunt hides the marker and highlights its "Guardrail" button; the user clicks it to have the guardrail
written. Do not ask whether to record it, never mark trivial answers or what the repository already records, and
write nothing yourself.
