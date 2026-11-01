Step `verify` for issue #{{number}} of {{repo}} on the branch `{{branch}}`.

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

Check the pushed change against the issue, as a tester who did not write it. The plan with its acceptance criteria is
`.hunt/swf/steps/01-plan.md`, what the implement step changed is its result in `.hunt/swf/steps/` (the newest
`*-implement.md`), the change itself the diff of the branch against its base; read the repository's guardrails before
you judge.

1. The gate of the implement step ran the repository's checks on the change already. Run a check yourself only where an
   acceptance criterion needs its output, with the command that hunt.json's `checks` names for it.
2. Go through the acceptance criteria of the plan (or of the issue) one by one and verify each: by a test, a command,
   or, for anything the user sees (a page, a component, styles, texts, a client-side flow), in the browser with the
   Playwright tools: start the services the task needs, open every affected page, walk through the flow the issue
   describes, compare what you see with what the issue asks for and read the browser console for errors. Look at each
   screenshot you take; a screenshot nobody looked at proves nothing.

The review step that follows reads the diff as a reviewer; here, judge whether the change does what the issue asks. Do
not fix anything in this step. Write the step result to `.hunt/swf/result.md`: a table of the acceptance criteria,
how each was checked and whether it passed, the checks you ran with their outcome, and the findings, each with its
severity, ending with
`<!-- hunt:step {"step":"verify","findings":[{"text":"<what is wrong and where>","severity":<1-5>}, "…"]} -->` — an
empty list when everything passed. Each finding's text is one sentence that says what is wrong and where, so that the
implement step can fix it; its severity is a whole number: 5 for a security issue, a loss of data or a broken build, 4
for an acceptance criterion the change does not meet or a bug you hit on the way, 3 for a check of hunt.json that fails
or a guardrail the change violates, 2 for a leftover or a change beyond the plan, 1 for a flaw in wording or style. A
criterion you cannot check is no finding: report it as unchecked, with the reason. Hunt sends back to implement only the
findings at or above the repository's `minSeverity` for this step (`swf.steps.verify.minSeverity` of hunt.json, 3
without it); the others stay in this result as suggestions for the people and the pull request.

The issue is labelled `{{stepLabel}}` while you work on this step. A question goes as "Questions to the people" says,
with `{{relabelQuestion}} --title "{{questionPrefix}}: <title>"` and `{{relabelResume}} --title "<title>"`; to give up, run
`{{relabelFailed}}` and say why.
