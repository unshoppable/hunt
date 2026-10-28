Step `gate` for issue #{{number}} of {{repo}} on the branch `{{branch}}` (pull request: {{pullRequest}}).

Decide whether a person has to review the pull request before Hunt merges it. The judgement must not come from the
context in which you wrote the change: delegate it to one subagent with the Agent tool, synchronously, and give it
nothing but this task:

> Read the diff of the branch `{{branch}}` against its base branch (`git diff origin/<base>...HEAD` and the untracked
> files), the issue #{{number}} of {{repo}} (`gh issue view {{number}} --repo {{repo}} --comments`) and the
> repository's rubric for the review necessity, its skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`), and judge
> by that rubric. Answer with exactly one JSON object `{"humanReview": true|false, "risk": "low"|"medium"|"high",
> "reasons": ["…"]}`: `humanReview` says whether a person has to review, `risk` how much can go wrong when the change
> is merged as it is, `reasons` the two to five facts about the diff that led to the judgement.

Post the step result: a comment on the issue that names the judgement and its reasons in a few lines, ending with the
subagent's object as `<!-- hunt:step {"step":"gate","humanReview":true,"risk":"medium","reasons":["…"]} -->`. The
repository's hunt.json may list files whose change always needs a person; the poller adds that on its own, you need not.

The issue is labelled `{{stepLabel}}` while you work on this step; to give up, run `{{relabelFailed}}` and say why.
