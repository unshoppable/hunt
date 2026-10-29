---
name: {{skillName}}
description: Turns a lesson from the current session — a correction by the user, a recurring problem with its solution, a workflow worth repeating — into the right guardrail (CLAUDE.md instruction, rule, skill, agent or ADR) at the right place, or explains why it does not qualify. Use when the user asks to record, remember or write down a convention, lesson or decision for the repository, or when Hunt's "Guardrail" button sends a suggestion. Takes the lesson as argument; without one, derives it from the conversation.
---

# Record a guardrail

A guardrail is an instruction this repository keeps for agents. Only broadly reusable knowledge becomes one; a guardrail
that repeats an existing one is a defect. Work through the steps in order and stop at the first that says no.

## 1. State the lesson

Write the lesson in one or two sentences: what to do, where, and why. Take it from the skill argument, else from the
conversation (the user's correction, the problem and its fix). If the why is unknown, ask for it before going on.

## 2. Does it qualify?

Hunt's "Guardrail" button lights up by the criteria between the two `hunt:criteria` comments; keep them around the list.

<!-- hunt:criteria -->
Yes only if it is one of:

- a convention for a whole part of the code or a whole kind of task,
- a recurring problem together with its solution,
- a workflow later sessions will repeat,
- an architectural decision that still binds future changes, affects more than one place, is recorded nowhere yet and
  would otherwise look wrong, be "fixed" or be questioned again.

No if it concerns one piece of code, file, migration, data set, bug or task, or describes how a single change was
carried out or verified. Knowledge that only the code shows is not recorded yet; what a CLAUDE.md, rule, skill, agent or
ADR already says is.
<!-- /hunt:criteria -->

When the answer is no, say so with the reason and suggest the nearest place that fits (a code comment, a line in the
docs, nothing).

## 3. Was it declined before?

`.claude/declined-guardrails.jsonl` holds every suggestion the user declined, one JSON object per line with `kind`,
`reason` (`tooSpecific`, `alreadyRecorded`, `notWanted`), `summary` and `declinedAt`; Hunt appends a line on every
decline. Never read the whole file:

```bash
grep -i '<key word>' .claude/declined-guardrails.jsonl
grep '"tooSpecific"' .claude/declined-guardrails.jsonl | tail -5
```

Stop if a declined entry covers the lesson, or if the lesson is as narrow as the last `tooSpecific` entries.

## 4. Does it exist already?

Search every kind, not only the one you expect:

```bash
grep -ril '<key word>' CLAUDE.md .claude/rules .claude/skills .claude/agents {{adrDir}}
```

Also read the rule whose `paths:` match the files the lesson concerns. If a guardrail already says it, stop and name it.
If one says part of it, extend that one instead of adding a new one.

## 5. Pick the kind by content

| The lesson is …                                                    | Kind        | Where                                              |
|--------------------------------------------------------------------|-------------|----------------------------------------------------|
| what every task in the repository or a folder needs to know first  | instruction | `CLAUDE.md` at the root or in that folder          |
| how code in a part of the repository is written                    | rule        | `.claude/rules/` (see below)                       |
| a workflow of several steps that recurs                            | skill       | `.claude/skills/<name>/SKILL.md`                   |
| a specialist task worth delegating with its own prompt             | agent       | `.claude/agents/<name>.md`                         |
| a decision made once between alternatives (criteria in step 2)     | ADR         | `{{adrDir}}/NNNN-title.md`                         |

A convention a linter can check also gets a lint rule, so the hooks report it. A convention that follows from an ADR is a
rule naming the ADR as its reason, not a second ADR. A CLAUDE.md takes no convention; it says where the guardrails live.

Rule placement: a rule for the whole repository goes to `.claude/rules/`; a rule for one part of the code goes into a
subfolder named after that part, and when it extends a root rule for that part it keeps the root rule's file name there
(`code-style.md` → `frontend/code-style.md`). Add to an existing topic file when one fits; create a new file only for a
new topic. Derive `paths:` from the files the lesson concerns; omit `paths:` only for a rule that applies to every turn.

## 6. Write it

Follow the format the kind's folder README describes when there is one. Rules and comments are English. State the
convention and its reason, not the incident that led to it; one NO/YES code example when the words alone leave room for
doubt. An ADR takes the number after the highest existing one and the sections Context, Decision and Consequences.

Show the user the target path and the text before writing. On approval, write it and update what points to it: the
README of the folder when it introduces a new topic, the ADR's Consequences for a rule derived from it. Never commit.
