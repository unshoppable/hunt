Step `implement` for issue #{{number}} of {{repo}} on the branch `{{branch}}`{{attemptNote}}.

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

## Findings to fix

{{findings}}

## Your task

Read the plan in `.hunt/swf/steps/01-plan.md` and the results of the steps that ran since (`.hunt/swf/steps/`, in the
order of their numbers: what earlier implement runs changed, what verify and the review found), then the repository's
guardrails. Carry out the plan, or, when the list above holds findings, fix every one of them: a finding of the verify
step or of the review step, a failing check, a change a reviewer requested or a merge conflict with the base branch
(then merge the base branch into your branch and resolve it). Follow the guardrails while you write and add or adjust
tests where the repository tests code like yours. The checks of the step's gate run when you write the result; run them
yourself first, and the repository's other checks for the projects you touched (build, tests, linters, type checks), so
that you do not lose a round. A failing check, a warning or a flaky test is yours to fix, or, when it clearly predates
your work and is out of scope, to note for the pull request. Read your whole diff once as a critical reviewer who did
not write it and fix what you find.

Then commit to `{{branch}}` with a message in the repository's commit convention (its guardrails and the step's skill say which), push, leave the working tree clean and write the step
result to `.hunt/swf/result.md`: a few lines on what you changed and which findings you fixed how, ending with
`<!-- hunt:step {"step":"implement","summary":"<one sentence>"} -->`.

The issue is labelled `{{stepLabel}}` while you work on this step. A question goes as "Questions to the people" says,
with `{{relabelQuestion}} --title "{{questionPrefix}}: <title>"` and `{{relabelResume}} --title "<title>"` once the answer
arrived; to give up, run `{{relabelFailed}}` and say why.
