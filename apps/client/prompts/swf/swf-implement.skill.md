---
name: {{skillName}}
description: Refines the implement step of Hunt's swf pipeline for this repository — its commands, the conventions most changes meet, the checks to run before a commit and the commit message. Invoked by the step's prompt only, never on its own.
---

# Implement step in this repository

Hunt's swf pipeline turns a GitHub issue into a merged pull request, one step per prompt. In the implement step the
agent carries out the plan it commented on the issue, or fixes the findings the prompt lists (of the verify step, a
failing check, the review, a reviewer or a merge conflict); it writes the tests, runs the checks, commits and pushes. The
step's prompt says what the step delivers and how it ends (its result, labels and questions); where this skill
disagrees with it on those, the prompt wins. This skill adds what this repository needs to implement a change: how its
commands run, which conventions most changes meet, which checks cover a change and how a commit is written.

## This repository

> Hunt wrote this section from its template. Replace each `TODO:` line with what this repository needs, or delete it
> when nothing applies, then delete this note. An agent in the step skips the `TODO:` lines that are left.

### Commands

TODO: how a part's scripts and targets run (build, tests, linters, type checks, code generators), and which hooks check
every edit and what their reports require.

### Conventions most changes meet

TODO: the rules most changes have to follow, such as a migration for every schema change, translation keys for new UI
texts, and where tests go and in which style.

### Before you commit

The checks of hunt.json (`checks`) are plain commands, such as `npm run …`, to run from the worktree. When the step
writes its result, Hunt runs the checks of the step's gate (`swf.steps.implement.checks`, every check by default) and sends
a red one back in the same conversation, so run them before you commit.

TODO: the checks of hunt.json or further commands that cover a change, by what it touches.

### Commit

TODO: the commit message convention, e.g. conventional commits with the type and scope this repository uses, and how a
message references the issue.
