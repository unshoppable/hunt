# Architectural decision records

Each file records one architectural decision that is still in force as `NNNN-title.md`, numbered in order, with its
date and the sections Context, Decision and Consequences.

## When to write an ADR

An ADR is worth writing only when all four apply:

- The decision is still in force and binds future changes.
- The code does not show it, or looks wrong without the reason.
- Someone would likely "fix" it or question it again.
- It affects more than one place. For a single place a comment in the code suffices: the agent reads it exactly when it
  changes that place, whereas it never loads an ADR on its own.

## Replacing an ADR

A decision that replaces an earlier one gets a new record, and the earlier record is deleted; git keeps its text. The
new record names the earlier one by number and title in its Context and says why its reason no longer holds. Numbers
are never reused: a new record takes the number after the highest one in `ls {{adrDir}}/` and
`git log --name-only --format= -- {{adrDir}}/`.

## ADR or rule

- An ADR records a decision made once between alternatives, such as a data model or a boundary between modules: why it
  was made and what follows from it. Claude Code does not load ADRs on its own; they explain the architecture to
  whoever asks why it is built this way.
- A rule in `{{ruleDir}}/` tells how code in one part of the repository is written and applies to every change there.
  Claude Code loads it while it works on that code.
- A convention that follows from a decision is a rule that names this ADR as its reason, not a second ADR.
