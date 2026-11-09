---
name: {{skillName}}
description: Writes the GitHub issue of a task together with the user before anyone codes it — reads the guardrails, the ADRs and the code the idea touches, interviews the user one question at a time until nothing is open, and files an issue a fresh agent can implement without asking back. Use when the user describes an idea, feature or bug that is to become a ticket, asks to write, refine or check an issue (`/{{skillName}} #123`), or when Hunt starts a ticket session. Takes the idea or an issue number as argument.
---

# Write a ticket

A ticket is a GitHub issue that an agent can implement from its text alone. Work through the steps in order; the
interview in step 4 is where most of the time goes, and it ends only when the checklist of step 5 holds.

## 1. Load the task

The argument is an idea in prose or an issue number.

- **Number:** `gh issue view <nr> --json number,title,body,labels,comments,assignees`. This run refines that issue:
  keep what its body says and take its comments into account. Never touch an issue an agent is working on; ask the user
  when its labels say so.
- **Idea:** start from it; the issue is created in step 6.

Keep the draft in `.hunt/ticket.md`, which git ignores; never commit it.

## 2. Read the context

- The root `CLAUDE.md`, the rules in `.claude/rules/`, the ADRs in `{{adrDir}}` and the skills of `.claude/skills/`
  whose descriptions touch the idea. The ticket follows the decisions it finds and names any it would contradict.
- `.hunt/graph.json` and the `.hunt/diagram.*.json` files when they exist: Hunt's dependency graph and diagrams of the
  code, which show what a change reaches.
- The code the idea is about: the modules, data and interfaces it touches, and the tests that cover them. Delegate a
  broad search to an Explore subagent and keep only its conclusions.

## 3. Draft

Fill every section of the template below. Write what you can settle from the code and the guardrails yourself and
mark it as settled; write what you can defend but did not verify under *Assumptions*; write what only the user can
answer under *Open questions*. The *Technical design* holds only what is new: it points to the ADRs, rules and files
that already decide things instead of repeating them. No task list: the implementing agent plans its own steps.

```markdown
# <title: the change in one line, as a verb phrase>

## Goal
<what is different after the change, for whom, and why that matters>

## Context
<where the idea comes from; links to tickets, pages, screenshots, data; the current behaviour and its problem>

## Scope
<what the change covers>
### Not in scope
<what it deliberately leaves out, and where that goes instead>

## Requirements
1. <one requirement per line, numbered, each about one observable behaviour>

## Acceptance criteria
- [ ] <one checkable criterion per line, tied to a requirement; names how it is checked: a test, a command, a page or flow in the browser>

## Technical design
- Touches: <modules, files, tables, endpoints, components; what changes in each>
- Follows: <the ADRs, rules and conventions that bind the change>
- Decisions: <each new decision with its reason and the alternative it rejects>
- Data and migration: <schema or data changes and how existing data moves, or "none">
- Risks: <what could break elsewhere and how the change guards against it, or "none">

## Verification
<how the result is checked as a whole: the checks to run, the flows to click through, the data to look at>

## Assumptions
<every assumption the user has not confirmed yet, one per line, or "none">

## Open questions
<every question only a person can answer, one per line with who answers it, or "none">
```

## 4. Interview

Show the draft, then ask the open questions and assumptions **one at a time**, starting with the one whose answer
changes the ticket most. Every question comes with the options you see and your recommendation; end the turn with
Hunt's question marker. Work the answer into the draft before the next question: a confirmed assumption becomes part
of the ticket and leaves *Assumptions*, a rejected one changes the ticket or becomes a question, a settled question
leaves *Open questions*. Never ask what the idea, the code or the guardrails already answer, and never bundle
questions. Go on until *Assumptions* and *Open questions* say `none`, or until the user stops; a question that needs
someone else stays under *Open questions* with that person's name.

## 5. Check

Before the ticket goes out, every line of this list must hold; fix the draft where one does not.

- Every requirement has at least one acceptance criterion, and every criterion says how it is checked.
- The design contradicts no ADR and no rule, or the ticket says which decision changes and that a ticket of its own
  records it.
- A fresh agent could implement it without asking back: the ticket names the files and concepts it touches, the
  decisions already made with their reasons and the way to verify the result.
- *Assumptions* and *Open questions* say `none`, or the user accepted the ones that remain.

## 6. File it

Show the final text and wait for the user's go. Then create or update the issue as "This repository" says:
`gh issue create --title "<title>" --body-file .hunt/ticket.md` with its labels, or `gh issue edit <nr> --body-file
.hunt/ticket.md` for an existing one, and add it to the project when the repository keeps one. Report the issue's URL
and delete the draft. Never post the questions or answers as comments: the body is the ticket.

## 7. Hand over

Say how the ticket gets implemented and do nothing of it yourself: a new Hunt session whose first prompt is the issue's
URL, or, where this repository runs Hunt's swf pipeline, the label that hands the issue to it, which the user adds when
they release the ticket.

## This repository

> Hunt wrote this section from its template. Replace each `TODO:` line with what this repository needs, or delete it
> when nothing applies, then delete this note. An agent skips the `TODO:` lines that are left.

### Language and form

TODO: the language the ticket is written in, the issue form or template it follows (`.github/ISSUE_TEMPLATE/`) and
which of its fields the sections above map to.

### Labels and project

TODO: the labels a new ticket gets (`gh issue create --label <name>`), the label that releases it to Hunt's swf pipeline
and who may add it, and the GitHub project it is added to (`gh project item-add <number> --owner <owner> --url <issue
url>`), by app or area when there are several.

### What to read

TODO: besides the guardrails of step 2, the documents that describe this repository's parts, their domain specs and
data, and how to find the decisions on a topic.

### Who answers

TODO: who answers which kind of open question (product, design, data, operations), so that a question that needs
someone else names them.
