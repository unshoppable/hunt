Step `gate` for issue #{{number}} of {{repo}} on the branch `{{branch}}` (pull request: {{pullRequest}}).

Decide whether a person has to review the pull request before Hunt merges it. This conversation is fresh: you did not
write the change, so judge it from what is on disk and on GitHub. Read the diff of the branch against its base branch
(`git diff origin/<base>...HEAD` and the untracked files), the issue (`gh issue view {{number}} --repo {{repo}}
--comments`), the plan and the step results in `.hunt/swf/steps/` and the repository's rubric for the review necessity,
its skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`), and judge by that rubric: `humanReview` says whether a
person has to review, `risk` how much can go wrong when the change is merged as it is (`low`, `medium` or `high`),
`reasons` the two to five facts about the diff that led to the judgement. A diff that adds or changes a guardrail (a
`CLAUDE.md`, a file in `.claude/`, a lint rule) always needs a person, whatever the rubric says.

Write the step result to `.hunt/swf/result.md`: the judgement and its reasons in a few lines, ending with
`<!-- hunt:step {"step":"gate","humanReview":true,"risk":"medium","reasons":["…"]} -->`. The repository's hunt.json may
list files whose change always needs a person; Hunt adds that on its own, you need not.

The issue is labelled `{{stepLabel}}` while you work on this step; to give up, run `{{relabelFailed}}` and say why.
