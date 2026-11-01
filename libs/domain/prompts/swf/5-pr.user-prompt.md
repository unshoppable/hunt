Step `pr` for issue #{{number}} of {{repo}} on the branch `{{branch}}`.

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

Open the pull request for the pushed branch. The plan in `.hunt/swf/steps/01-plan.md`, the results of the implement and
verify runs beside it and the diff of the branch against its base tell what was done, which decisions were taken and
how the change was checked. The description follows the repository's pull request template when it has one, contains
`Closes #{{number}}`, names the decisions, says how the change was checked, lists what was noted as out of scope and,
under a heading of their own, the findings of the verify and review runs that stayed below the step's `minSeverity`
(the suggestions in `.hunt/swf/steps/*-verify.md` and `*-review.md` that no implement run fixed), so that the reviewer
sees them.
Use the repository's conventions for the title (the step's skill says which). Then stop the
services that run (`sudo -n hunt-ctl service stop <name>…`), close the tmux windows that are open, delete scratch files
outside the repository and leave the working tree clean: `git status` shows nothing uncommitted.

Write the step result to `.hunt/swf/result.md`: the pull request's link, ending with
`<!-- hunt:step {"step":"pr","pullRequest":<number>} -->`; Hunt posts it on the issue, so do not comment the link
yourself. From here on Hunt watches the pull request: its checks and the repository's review workflow run on GitHub;
that workflow decides whether a person reviews before Hunt merges it. When a check or a reviewer finds something, you get it as an
`implement` step.

The issue is labelled `{{stepLabel}}` while you work on this step; to give up, run `{{relabelFailed}}` and say why.
