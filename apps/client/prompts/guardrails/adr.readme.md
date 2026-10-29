# Architectural decision records

Each file records one architectural decision that is still in force as `NNNN-title.md`, numbered in order, with its
date and the sections Context, Decision and Consequences.

## When to write an ADR

An ADR keeps the reason for a decision that shapes the source code, so that no one reverses the decision by accident.
Only a decision of real weight and reach gets one; otherwise every decision would become an ADR. Before writing one,
judge two things:

- How likely another agent is to reverse it: the code looks wrong or roundabout without the reason, or a simpler
  alternative invites a "fix".
- How hard it is to work out why it was made: the reason lies outside the code (a regulation, an incident, a
  measurement, a rejected alternative) or only shows across several modules.

When both are low, write no ADR. The decision must also still be in force and bind future changes. A decision that
affects a single place gets a comment in the code instead: the agent reads it exactly when it changes that place,
whereas it never loads an ADR on its own.

## Replacing an ADR

A decision that replaces an earlier one gets a new record, and the earlier record is deleted; git keeps its text. The
new record names the earlier one by number and title in its Context and says why its reason no longer holds. Numbers
are never reused: a new record takes the number after the highest one in `ls {{adrDir}}/` and
`git log --name-only --format= -- {{adrDir}}/`.

## ADR, rule or skill

- An ADR records a weighty decision that shapes the source code, such as a data model or a boundary between modules:
  why it was made and what follows from it. Claude Code does not load ADRs on its own; they explain the architecture to
  whoever asks why it is built this way.
- A rule in `{{ruleDir}}/` is an instruction whose scope follows from file paths or names; Claude Code loads it while it
  works on a matching file.
- A skill in `.claude/skills/` is an instruction whose scope only the situation tells; Claude Code loads it when its
  description matches the task.
- A convention that follows from a decision is a rule that names this ADR as its reason, not a second ADR.
