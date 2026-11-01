Step `implement` for issue #{{number}} of {{repo}} on the branch `{{branch}}`{{attemptNote}}.

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

## Findings to fix

{{findings}}

## Your task

Read the plan in `.hunt/swf/steps/01-plan.md` and the results of the steps that ran since (`.hunt/swf/steps/`, in the
order of their numbers: what earlier implement runs changed, what verify found), then the repository's guardrails. Carry
out the plan, or, when the list above holds findings, fix every one of them: a finding of the verify step, a failing
check, a blocking finding of the Claude review, a change a reviewer requested or a merge conflict with the base branch
(then merge the base branch into your branch and resolve it). Follow the guardrails while you write, add or adjust
tests where the repository tests code like yours, and run the repository's checks for the projects you touched (build,
tests, linters, type checks) before you finish; a failing check, a warning or a flaky test is yours to fix, or, when it
clearly predates your work and is out of scope, to note for the pull request. Read your whole diff once as a critical
reviewer who did not write it and fix what you find.

Then commit to `{{branch}}` with a conventional commit message, push, leave the working tree clean and write the step
result to `.hunt/swf/result.md`: a few lines on what you changed and which findings you fixed how, ending with
`<!-- hunt:step {"step":"implement","summary":"<one sentence>"} -->`.

The issue is labelled `{{stepLabel}}` while you work on this step. A question goes as "Questions to the people" says,
with `{{relabelQuestion}} --title "❓ RÜCKFRAGE: <title>"` and `{{relabelResume}} --title "<title>"` once the answer
arrived; to give up, run `{{relabelFailed}}` and say why.
