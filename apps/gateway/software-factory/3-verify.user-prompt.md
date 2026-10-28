Step `verify` for issue #{{number}} of {{repo}} on the branch `{{branch}}`.

Invoke the repository's skill `{{skill}}` (`.claude/skills/{{skill}}/SKILL.md`) first and follow it; it refines this step for the repository.

Check the pushed change against the issue, as a tester who did not write it:

1. Run every check the repository's hunt.json declares (`sudo -n hunt-ctl check <name>`; `hunt.json` lists them under
   `checks`) and the repository's own build, tests, linters and type checks for the projects the change touches, unless
   hunt.json's checks cover them already.
2. Go through the acceptance criteria of your plan comment (or of the issue) one by one and verify each: by a test, a
   command, or, for anything the user sees (a page, a component, styles, texts, a client-side flow), in the browser with
   the Playwright tools: start the services the task needs, open every affected page, walk through the flow the issue
   describes, compare what you see with what the issue asks for and read the browser console for errors. Look at each
   screenshot you take; a screenshot nobody looked at proves nothing.
3. Read the whole diff against the base branch once more with the guardrails open: does the change do everything the
   issue asks and nothing beyond it, does every line follow the guardrails, which inputs, states or edge cases does it
   handle wrong, is anything left over (debugging output, commented-out code, scratch files, TODOs)?

Do not fix anything in this step. Post the step result: a comment on the issue with a table of the acceptance criteria,
how each was checked and whether it passed, the checks you ran with their outcome, and the findings, ending with
`<!-- hunt:step {"step":"verify","findings":["<finding>", "…"]} -->` — an empty list when everything passed. Each
finding is one sentence that says what is wrong and where, so that the implement step can fix it.

The issue is labelled `{{stepLabel}}` while you work on this step. A question goes as "Questions to the people" says,
with `{{relabelQuestion}} --title "❓ RÜCKFRAGE: <title>"` and `{{relabelResume}} --title "<title>"`; to give up, run
`{{relabelFailed}}` and say why.
