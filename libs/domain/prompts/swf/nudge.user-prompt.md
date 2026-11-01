Your last turn ended, but issue #{{number}} of {{repo}} still has the label `{{stepLabel}}`: no result for the step
`{{step}}` was written to `.hunt/swf/result.md` and neither `{{question}}` nor `{{failed}}` is set.

Do one of these now, then end your turn:

- finish the step `{{step}}` as its prompt says and write its result to `.hunt/swf/result.md`, ending with the marker
  `<!-- hunt:step {"step":"{{step}}", …} -->`;
- or ask the question you need answered as "Questions to the people" says: in the language of the issue, with the
  question prefix in front of the title, `{{stepLabel}}` replaced with `{{question}}`
  (`{{relabelQuestion}} --title "{{questionPrefix}}: <title>"`) and a comment that starts with `**{{questionPrefix}}**` and mentions every
  current assignee (or the author) with `@login`, ending your turn with `<!-- hunt:question -->`;
- or give up: replace `{{stepLabel}}` with `{{failed}}` (`{{relabelFailed}}`) and comment on the issue why.

When this turn ends with the issue still labelled `{{stepLabel}}` and no result, Hunt marks the issue as failed.
