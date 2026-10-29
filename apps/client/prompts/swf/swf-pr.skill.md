---
name: {{skillName}}
description: Refines the pr step of Hunt's swf pipeline for this repository — the title, the pull request template and how to fill it, the base branch and what runs once the pull request is open. Invoked by the step's prompt only, never on its own.
---

# Pull request step in this repository

Hunt's swf pipeline turns a GitHub issue into a merged pull request, one step per prompt. In the pr step the agent opens
the pull request for the pushed branch (`Closes #<issue>`, the decisions it took, how it checked the change, what it
left out of scope), comments its link on the issue and cleans up the VM. The step's prompt says what the step delivers
and how it ends (its result, labels and questions); where this skill disagrees with it on those, the prompt wins. This
skill adds what this repository needs in a pull request: its title, its template, its base branch and the reviews and
checks that follow.

## This repository

> Hunt wrote this section from its template. Replace each `TODO:` line with what this repository needs, or delete it
> when nothing applies, then delete this note. An agent in the step skips the `TODO:` lines that are left.

### Title

TODO: the format of a pull request's title, such as a conventional commit with the scopes of the commits, and what it
never contains.

### Body

TODO: the pull request template (`.github/PULL_REQUEST_TEMPLATE.md` or wherever it lives) and how to fill each of its
parts: where `Closes #<issue>` goes, how long the description is, which boxes to tick when.

### Base branch

TODO: the base branch and the command that opens the pull request, such as
`gh pr create --base <branch> --title … --body-file …`.

### After the pull request opens

TODO: the reviews and checks that run on their own (a Claude review workflow, required checks) and anything that has to
be started by hand.
