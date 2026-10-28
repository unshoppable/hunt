---
name: {{skillName}}
description: Refines the plan step of Hunt's swf pipeline for this repository — which part of the code an issue is about, which guardrails to read for it and how the acceptance criteria are written and checked. Invoked by the step's prompt only, never on its own.
---

# Plan step in this repository

Hunt's swf pipeline turns a GitHub issue into a merged pull request, one step per prompt. In the plan step the agent
reads the issue and the repository's guardrails, asks the questions only a person can answer and comments a plan on the
issue: the approach, the files it touches, the acceptance criteria and how each of them is checked. The step's prompt
says what the plan delivers and how the step ends (its result, labels and questions); where this skill disagrees with
it on those, the prompt wins. This skill adds what this repository needs to plan well: where an issue's code lives,
what to read before planning and how its acceptance criteria are written and checked.

## This repository

> Hunt wrote this section from its template. Replace each `TODO:` line with what this repository needs, or delete it
> when nothing applies, then delete this note. An agent in the step skips the `TODO:` lines that are left.

### Which part of the code

TODO: how an issue names the part of the code it is about (a field of the issue form, a label), where that part's code,
its shared code and its scripts live, and which changes reach other parts too.

### What to read

TODO: besides the root `CLAUDE.md` and the rules Claude Code loads on its own, the guardrails, indexes and documents to
read for each kind of task (frontend, backend, database, …), how to find the architectural decisions on the issue's
topic, and where the services and data of a part are described.

### The acceptance criteria

TODO: where the issue keeps its acceptance criteria, how to word one it lacks, and how each kind of criterion is checked
here: which tests and where they go, which commands, which pages or flows in the browser.

### What the plan says

TODO: what the plan states beyond the step's prompt, such as the language it is written in, whether the change needs a
migration and whether it touches a path of hunt.json `swf.humanReviewPaths`, so that the people know a review is coming.
