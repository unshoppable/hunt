Step `review` for issue #{{number}} of {{repo}} on the branch `{{branch}}` (pull request: {{pullRequest}}).

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

Review the pushed change as a reviewer who did not write it. This conversation is fresh: you did not write the change,
so judge it from what is on disk and on GitHub. Read the diff of the branch against its base branch (`git diff
origin/<base>...HEAD` and the untracked files), the issue (`gh issue view {{number}} --repo {{repo}} --comments`), the
plan and the step results in `.hunt/swf/steps/` and the repository's guardrails for the files the change touches; when
the pull request exists already, also the comments on it, since a reviewer may have asked for something there.

Judge the whole change by the repository's review criteria: is it correct, does it handle its inputs, states and edge
cases, is it secure, does every line follow the guardrails, does it carry the tests the guardrails demand, does it
duplicate what the repository has, is anything left over (debugging output, commented-out code, scratch files, TODOs),
does it go beyond the plan? Do not fix anything in this step.

Write the step result to `.hunt/swf/result.md`: a few lines on what you reviewed and the findings, each with its
severity, ending with
`<!-- hunt:step {"step":"review","findings":[{"text":"<file>: <what is wrong>","severity":<1-5>}, "…"]} -->` — an empty
list when the change is clean. Each finding's text is one sentence that names the file and what is wrong there, so that
the implement step can fix it; its severity is a whole number of this scale:

| severity | the finding is |
| --- | --- |
| 5 | a security issue, a loss of data, a broken build or deployment |
| 4 | a bug, or a requirement of the issue the change does not meet |
| 3 | a violation of a repository guardrail, or a test the guardrails demand but the change lacks |
| 2 | duplication of what the repository has, a leftover (debugging output, commented-out code, scratch file, TODO), a change beyond the plan |
| 1 | style, naming, wording, a nicer way to do it |

List every finding you would raise as a reviewer. Hunt sends back to implement only the findings at or above the
repository's `minSeverity` for this step (`swf.steps.review.minSeverity` of hunt.json, 3 without it); the others stay in
this result as suggestions for the people and the pull request. The repository's skill may say how its review criteria
map onto the scale; without it, use the table.

The issue is labelled `{{stepLabel}}` while you work on this step; to give up, run `{{relabelFailed}}` and say why.
