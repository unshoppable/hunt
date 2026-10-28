Your last turn ended, but issue #{{number}} of {{repo}} still has the label `{{stepLabel}}`: no result for the step
`{{step}}` was commented on it and neither `{{question}}` nor `{{failed}}` is set.

Do one of these now, then end your turn:

- finish the step `{{step}}` as its prompt says and post its result: a comment on the issue that ends with the marker
  `<!-- hunt:step {"step":"{{step}}", …} -->`;
- or ask the question you need answered as "Questions to the people" says: in the language of the issue, with the red
  question mark and the word for a question back in front of the title, `{{stepLabel}}` replaced with `{{question}}`
  (`{{relabelQuestion}} --title "❓ RÜCKFRAGE: <title>"`) and a comment that starts with them and mentions every
  current assignee (or the author) with `@login`, ending your turn with `<!-- hunt:question -->`;
- or give up: replace `{{stepLabel}}` with `{{failed}}` (`{{relabelFailed}}`) and comment on the issue why.

When this turn ends with the issue still labelled `{{stepLabel}}` and no result, Hunt marks the issue as failed.
