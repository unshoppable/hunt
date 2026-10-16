## Working on a GitHub issue

Hunt's poller started this session for issue #{{number}} of {{repo}}, which carries the label `{{requested}}`; the first prompt holds the issue with all its comments. Nobody watches while you work: decide details on your own where the issue, the repository and its conventions settle them, and name your decisions in the pull request. Work through these steps in order:

1. **Read the task.** Read the issue and its comments, then the README, CLAUDE.md and the other instructions of the repository, and find the code the issue is about.
2. **Clarify questions.** When a question remains that only a person can answer, ask it before you plan: gather every open question into one comment on the issue (`gh issue comment {{number}} --repo {{repo}} --body "…"`) with the options you see and your recommendation. Start the comment by mentioning everyone who is to answer, so that GitHub notifies them: every current assignee of the issue (`gh issue view {{number}} --repo {{repo}} --json assignees -q '.assignees[].login'`) as `@login`, or the issue's author when it has no assignee. Then replace `{{running}}` with `{{question}}` (`{{relabelQuestion}}`) and end your turn with the questions as your last words and the marker `<!-- hunt:question -->`. The answer reaches you as your next prompt; then replace `{{question}}` with `{{running}}` (`{{relabelResume}}`) and go on.
3. **Plan.** Comment a short implementation plan on the issue: the approach, the files it touches and how you will check it. Then carry it out without waiting for approval; the comment lets the person follow your way and step in from Hunt.
4. **Implement and check.** Implement the plan. Check your change as a developer would locally: build it and run the tests and linters the repository uses; for changes the user sees, start the app and check it with the Playwright tools.
5. **Pull request.** Commit to the current branch `{{branch}}`, push it and open a pull request whose description contains `Closes #{{number}}` and names the decisions you took. Comment the pull request's link on the issue.
6. **Clean up and finish.** Stop the services you started (`sudo -n hunt-ctl service stop <name>…`) and close the tmux windows you opened, delete the scratch files you created outside the repository and leave the working tree clean: `git status` shows nothing uncommitted. Then replace `{{running}}` with `{{done}}`: `{{relabelDone}}`.

When you cannot complete the task, replace `{{running}}` with `{{failed}}` instead (`{{relabelFailed}}`) and comment on the issue why.

Do not end your turn in any other way before step 6 is done: a turn that ends with the issue still labelled `{{running}}` counts as an unfinished task.
