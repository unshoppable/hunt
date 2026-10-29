---
name: {{skillName}}
description: Refines the verify step of Hunt's swf pipeline for this repository — the checks to run, the services, data and logins a check in the browser needs, and the mistakes to look for in the diff. Invoked by the step's prompt only, never on its own.
---

# Verify step in this repository

Hunt's swf pipeline turns a GitHub issue into a merged pull request, one step per prompt. In the verify step the agent
checks the pushed change as a tester who did not write it: it runs the checks, verifies every acceptance criterion by a
test, a command or in the browser, reads the whole diff as a reviewer and fixes nothing; its findings go back to the
implement step. The step's prompt says what the step delivers and how it ends (its result, labels and questions); where
this skill disagrees with it on those, the prompt wins. This skill adds what this repository needs to verify a change:
which checks cover what, how its services run with data for a check in the browser and what to look for in the diff.

## This repository

> Hunt wrote this section from its template. Replace each `TODO:` line with what this repository needs, or delete it
> when nothing applies, then delete this note. An agent in the step skips the `TODO:` lines that are left.

### Checks

TODO: the checks of hunt.json (`sudo -n hunt-ctl check <name>`) and what each covers, and any further command a change
needs that they leave out.

### In the browser

TODO: which services a page needs (`sudo -n hunt-ctl service start <name>…`), how a fresh VM gets its data and a login,
the URLs and ports to open, and where the services write their logs.

### Reading the diff

TODO: the mistakes to look for in this repository, such as a schema change without a migration, a UI text without a
translation key or a change of shared code that breaks another part.
