---
name: {{skillName}}
description: Refines the review step of Hunt's swf pipeline for this repository — the criteria the diff is read against and the guardrails per changed file. Invoked by the step's prompt only, never on its own.
---

# Review step in this repository

Hunt's swf pipeline turns a GitHub issue into a merged pull request, one step per prompt. In the review step an agent
with a fresh context reads the whole change of the branch (`git diff origin/<base>...HEAD`, not only the last commit)
as a reviewer who did not write it: it judges the diff by the criteria below and the repository's guardrails, fixes
nothing, and its findings go back to the implement step. The step's prompt says what the review delivers and how the
step ends (its result, labels and questions); where this skill disagrees with it on those, the prompt wins. This skill
adds the criteria the diff is read against and where the guardrails of this repository live.

## Review criteria

Read the diff against each of these; a finding names the file and line, what is wrong and why:

- **Correctness**: the change does what the issue and its plan ask, handles the edge cases of its inputs and breaks no
  caller of what it changed.
- **Security**: no secret in the code, no input that reaches a shell, a query or a page unchecked, no widened access.
- **Guardrails**: every changed file follows the rules of the repository that apply to it (`CLAUDE.md`, the rules and
  decisions it points to); a rule that binds the change and was not followed is a finding, a rule that is missing is
  not.
- **Tests**: the tests the guardrails demand for this kind of change exist, cover the change and would fail without it.
- **Duplication and reuse**: the change reuses what the repository already has instead of adding a second version of it,
  and introduces nothing more general than the issue needs.
- **Leftovers**: no debugging output, commented-out code, stale comment, unused import or TODO the change leaves behind.

A finding is **blocking** when the pull request must not merge with it (a bug, a security hole, a broken guardrail, a
missing demanded test); everything else is a **suggestion**. The result says which is which.

## This repository

> Hunt wrote this section from its template. Replace each `TODO:` line with what this repository needs, or delete it
> when nothing applies, then delete this note. An agent in the step skips the `TODO:` lines that are left.

TODO: where the guardrails of this repository live beyond the root `CLAUDE.md` (its rules, its architectural decisions,
its lint configuration) and which of them apply to which part of the code, so that the review need not search for them.

TODO: the mistakes to look for in this repository, such as a schema change without a migration, a UI text without a
translation key or a change of shared code that breaks another part.

TODO: the tests the guardrails demand for each kind of change (a new endpoint, a new component, a migration) and where
they go.
