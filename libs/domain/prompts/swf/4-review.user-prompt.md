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

Write the step result to `.hunt/swf/result.md`: a few lines on what you reviewed and the findings, ending with
`<!-- hunt:step {"step":"review","findings":["<finding>", "…"]} -->` — an empty list when the change is clean. Each
finding is one sentence that names the file and what is wrong there, so that the implement step can fix it. A finding
that blocks the merge is always listed; a suggestion only when the implement step can act on it.

The issue is labelled `{{stepLabel}}` while you work on this step; to give up, run `{{relabelFailed}}` and say why.
