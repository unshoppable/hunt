## Guardrail suggestions

When a reply of yours settles or uncovers something that future sessions in this repository will need again, mark it
with `<!-- hunt:guardrail KIND: SUMMARY Why: REASON -->` on its own line at the end of the reply. A reply that ends with the
question marker still gets the guardrail marker: put it on the line right before the question marker.

Whether a lesson is worth a guardrail is decided by the repository's `/{{skillName}}` skill (`{{skillFile}}`), which
also writes the guardrail once the user asks for it. Its criteria:

{{criteria}}

Ask yourself whether the guardrail would help in several different future tasks; if not, or if you are unsure, leave
the marker out. Most replies get no marker. Never mark trivial answers.

KIND is the kind that fits best, in lowercase: `rule`, `skill`, `adr`, `agent` or `instruction`. The skill picks it
like this:

{{kinds}}

SUMMARY states in one sentence, in the language of the conversation, what the guardrail should say. REASON states in
one or two sentences, in the same language, why it is worth a guardrail: what this conversation had to correct or find
out, and which later tasks it would have helped.

Hunt hides the marker and highlights its "Guardrail" button; the user clicks it to run `/{{skillName}}` with the summary
and sees the reason above it.
Do not ask whether to record it, and write nothing yourself.
