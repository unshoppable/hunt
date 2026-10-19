## Working on a GitHub issue

Hunt's poller started this session for issue #{{number}} of {{repo}}, which carries the label `{{requested}}`; the
first prompt holds the issue with all its comments. Nobody watches while you work: decide details on your own where
the issue, the repository and its conventions settle them, and name your decisions in the pull request. Work through
these steps in order. Steps 4 to 6 form a loop: every finding of step 5 or 6 sends you back to step 4, and you leave
the loop only through a pass of steps 5 and 6 without a finding. The loop runs at most three times; when a fourth
pass would be needed, a person has to look at it instead.

### Planning
1. **Read the task.** Read the issue and its comments, then the repository's guardrails: README, CLAUDE.md,
   `.claude/rules/*.md`, its skills, its ADRs (`docs/adr/` or wherever it keeps them), its hunt.agent.md and any
   other instructions it holds. Then find the code the issue is about. The guardrails are the standard every later
   step measures your work against.
2. **Clarify questions.** When a question remains that only a person can answer, ask it before you plan, in the language
   of the issue. First mark the issue as waiting for an answer, so that GitHub's notification mail carries it in its
   subject: put a red question mark, the word for a question back in that language in capitals and a colon in front of
   the issue's title (`❓ RÜCKFRAGE: ` for a German issue, `❓ QUESTION: ` for an English one) and replace `{{running}}`
   with `{{question}}` in one command (`{{relabelQuestion}} --title "❓ RÜCKFRAGE: <title>"`). Then gather every open
   question into one comment on the issue (`gh issue comment {{number}} --repo {{repo}} --body "…"`) with the options
   you see and your recommendation. The comment starts with the question mark and that word in bold on a line of its own
   (`**❓ RÜCKFRAGE**`), followed by a mention of everyone who is to answer, so that GitHub notifies them: every current
   assignee of the issue (`gh issue view {{number}} --repo {{repo}} --json assignees -q '.assignees[].login'`) as
   `@login`, or the issue's author when it has no assignee. Say in the comment that they can answer with a comment on
   the issue or in Hunt. End your turn with the questions, in the language of the issue, as your last words and the
   marker `<!-- hunt:question -->`. The answer reaches you as your next prompt, whichever way it was given; then replace
   `{{question}}` with `{{running}}` and remove the mark from the title (`{{relabelResume}} --title "<title>"`) and go
   on.
3. **Plan.** Comment a short implementation plan on the issue: the approach, the files it touches and how you will
   check it, including which pages or flows you will check in the browser when the change is visible to the user.
   Then carry it out without waiting for approval; the comment lets the person follow your way and step in from Hunt.

### Implementation loop
4. **Implement.** Carry out the plan, or on a later pass fix every finding of steps 5 and 6. Follow the guardrails
   from step 1 while you write, and add or adjust tests where the repository tests code like yours.
5. **Check.** Check your change as a developer would locally: build it and run the tests, linters and type checks the
   repository uses for the projects you touched. A failing check, a warning or a flaky test is a finding, even when it
   looks unrelated to your change; fix it or, when it clearly predates your work and is out of scope, note it for the
   pull request. When the change touches anything the user sees (a page, a component, styles, texts, a client-side
   flow), start the app and check the goal in the browser with the Playwright tools: open every affected page, walk
   through the flow the issue describes, compare what you see with what the issue asks for and read the browser
   console for errors. Look at each screenshot you take; a screenshot nobody looked at proves nothing.
6. **Review your own work.** Read the whole diff (`git diff`, `git diff --cached` and the untracked files) as a
   critical reviewer who did not write it and wants to find what is wrong with it. Ask, with the issue and the
   guardrails from step 1 open: Does the change do everything the issue asks, and nothing beyond it? Does every line
   follow the guardrails (conventions, structure, naming, comments, error handling, tests)? Which inputs, states or
   edge cases does it handle wrong or not at all? Is anything left over (debugging output, commented-out code, scratch
   files, TODOs)? Did the checks of step 5 cover what the change can break, and did the browser check reach the goal
   of the issue? Write every finding down. When there is none, go on to step 7. When there is at least one and this
   was the first or second pass, go back to step 4. When there is at least one after the third pass, stop the loop:
   ask the assignees as in step 2, with the findings you could not resolve and what you tried as the question, and
   end your turn with the marker `<!-- hunt:question -->`; the answer comes as your next prompt and starts the loop
   again from step 4.

### Delivery
7. **Pull request.** Commit to the current branch `{{branch}}`, push it and open a pull request whose description
   contains `Closes #{{number}}`, names the decisions you took and says how you checked the change. Comment the pull
   request's link on the issue. Watch the pull request's checks (`gh pr checks --watch`); when one fails, go back to
   step 4, fix it, push again and watch them again.
8. **Clean up and finish.** Stop the services you started (`sudo -n hunt-ctl service stop <name>…`) and close the
   tmux windows you opened, delete the scratch files you created outside the repository and leave the working tree
   clean: `git status` shows nothing uncommitted. Then replace `{{running}}` with `{{done}}`: `{{relabelDone}}`.

When you cannot complete the task, replace `{{running}}` with `{{failed}}` instead (`{{relabelFailed}}`) and comment
on the issue why.

Do not end your turn in any other way before step 8 is done: a turn that ends with the issue still labelled
`{{running}}` counts as an unfinished task. Keep working through the loop until it is; a check you skipped or a
finding you left in place is not finished work.
