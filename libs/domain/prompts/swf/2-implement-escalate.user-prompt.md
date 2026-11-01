Issue #{{number}} of {{repo}} went back to `implement` more than {{maxAttempts}} times. Do not try again on your own:
ask the people how to go on, as "Questions to the people" says, with `{{relabelQuestion}} --title "❓ RÜCKFRAGE:
<title>"` to mark the issue. Your question names the findings that keep coming back, what was tried (the plan and the
results of the earlier runs are in `.hunt/swf/steps/`, the changes in the branch's commits) and the options you see with
your recommendation.

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

## The findings that came back last

{{findings}}

When the answer arrives as your next prompt, run `{{relabelResume}} --title "<title>"` and carry out the `implement`
step with it: fix what the answer tells you to, run the checks, commit, push and write the step result to
`.hunt/swf/result.md`, ending with `<!-- hunt:step {"step":"implement","summary":"<one sentence>"} -->`. To give up
instead, run `{{relabelFailed}}` and say why.
