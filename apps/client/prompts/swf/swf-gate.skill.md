---
name: {{skillName}}
description: Refines the gate step of Hunt's swf pipeline for this repository — the rubric for when a person must review a pull request before Hunt merges it. Invoked by the step's prompt only, which hands it to its judging subagent; never on its own.
---

# Gate step in this repository

Hunt's swf pipeline turns a GitHub issue into a merged pull request, one step per prompt. In the gate step a subagent
with a fresh context judges from the branch's diff, the issue and this skill whether a person has to review the pull
request before Hunt merges it, and how much can go wrong when it is merged as it is. The step's prompt says what the
judgement delivers and how the step ends; where this skill disagrees with it on those, the prompt wins. This skill adds
the rubric: which changes need a person in this repository and which do not.

## Review necessity

Judge the whole change of the branch (`git diff --stat origin/<base>...HEAD`), not only the last commit.

A person must review when any of these holds:

- it touches data migrations or schemas;
- it touches authentication, authorization or tenancy;
- it touches billing or revenue calculations;
- it touches an external integration;
- it touches CI or deploy configuration;
- it touches other security-relevant code;
- the diff exceeds about 400 changed lines or 15 files;
- not every acceptance criterion of the issue could be verified automatically.

No person is needed when the change consists only of:

- isolated texts;
- styling;
- a small bug fix with a test that covers it;
- documentation;
- a refactor without a change in behaviour whose tests pass.

One reason for a review outweighs any number of reasons against one. A pull request that touches a path of hunt.json
`swf.humanReviewPaths` always gets a review; Hunt enforces that itself.

## This repository

> Hunt wrote this section from its template. Replace each `TODO:` line with what this repository needs, or delete it
> when nothing applies, then delete this note. The judging subagent skips the `TODO:` lines that are left.

TODO: where the changes of the lists above live in this repository (its migrations, its authorization code, its CI and
deploy files, its integrations), so that the judgement need not guess from file names.

TODO: the changes that need a person only in this repository, such as code every part of it shares, and those that never
need one; add them to the lists above.
