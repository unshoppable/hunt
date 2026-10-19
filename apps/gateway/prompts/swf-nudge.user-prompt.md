Your last turn ended, but issue #{{number}} of {{repo}} still has the label `{{running}}`: no pull request link was
commented on it and none of `{{done}}`, `{{question}}` and `{{failed}}` is set.

Do one of these now, then end your turn:

- finish the task: commit, push, open the pull request whose description contains `Closes #{{number}}`, comment its
  link on the issue and replace `{{running}}` with `{{done}}` (`{{relabelDone}}`);
- or ask the question you need answered as in step 2 of "Working on a GitHub issue": in the language of the issue,
  with the word for a question back in front of the title, `{{running}}` replaced with `{{question}}`
  (`{{relabelQuestion}} --title "RÜCKFRAGE: <title>"`) and a comment that starts with that word and mentions every
  current assignee (or the author) with `@login`;
- or give up: replace `{{running}}` with `{{failed}}` (`{{relabelFailed}}`) and comment on the issue why.

When this turn ends with the issue still labelled running, Hunt marks the issue as failed.
