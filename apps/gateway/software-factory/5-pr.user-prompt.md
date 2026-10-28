Step `pr` for issue #{{number}} of {{repo}} on the branch `{{branch}}` (a person reviews before the merge: {{humanReview}}).

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

Open the pull request for the pushed branch: its description follows the repository's pull request template when it has
one, contains `Closes #{{number}}`, names the decisions you took, says how you checked the change and lists what you
noted as out of scope. Use the repository's conventions for the title (conventional commit format when the repository
uses it). Then comment the pull request's link on the issue, stop the services you started (`sudo -n hunt-ctl service
stop <name>…`), close the tmux windows you opened, delete the scratch files you created outside the repository and leave
the working tree clean: `git status` shows nothing uncommitted.

Post the step result: a comment on the issue with the pull request's link, ending with
`<!-- hunt:step {"step":"pr","pullRequest":<number>} -->`. From here on the poller watches the pull request: its checks
and the Claude review run on GitHub, a person reviews when the gate asked for one, and Hunt merges it. When a check,
the review or a reviewer finds something, you get it as an `implement` step.

The issue is labelled `{{stepLabel}}` while you work on this step; to give up, run `{{relabelFailed}}` and say why.
