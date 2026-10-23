# Architectural decision records

Each file records one architectural decision as `NNNN-title.md`, numbered in order, with its date and the sections
Context, Decision and Consequences. A decision that replaces an earlier one gets a new record that names the earlier
one.

## ADR or rule

- An ADR records a decision made once between alternatives, such as a framework, a data model or a boundary between
  modules: why it was made and what follows from it. Claude Code does not load ADRs on its own; they explain the
  architecture to whoever asks why it is built this way.
- A rule in `{{ruleDir}}/` tells how code in one part of the repository is written and applies to every change there.
  Claude Code loads it while it works on that code.
- A convention that follows from a decision is a rule that names this ADR as its reason, not a second ADR.
