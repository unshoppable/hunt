Work on GitHub issue #{{number}} of {{repo}}: {{title}}
{{url}}

## Issue, opened by @{{author}} on {{createdAt}}

{{body}}

## Comments

{{comments}}

## Your task

Hunt's poller started this session because the issue has the label `{{requested}}`. Nobody watches while you work: decide details on your own where the issue, the repository and its conventions settle them, and name your decisions in the pull request.

1. Implement the issue in this repository. Read the README, CLAUDE.md and the other instructions of the repository first.
2. Check your change as a developer would locally: build it and run the tests and linters the repository uses; for changes the user sees, start the app and check it with the Playwright tools.
3. Commit to the current branch `{{branch}}`, push it and open a pull request whose description contains `Closes #{{number}}`.
4. Comment the pull request's link on the issue: `gh issue comment {{number}} --repo {{repo}} --body "…"`.
5. Finally replace the label `{{running}}` with `{{done}}`: `{{relabelDone}}`.

When you cannot complete the task, replace `{{running}}` with `{{failed}}` instead (`{{relabelFailed}}`) and comment on the issue why.

When you need an answer only a person can give, ask on the issue instead of deciding: comment your question (`gh issue comment {{number}} --repo {{repo}} --body "…"`), replace `{{running}}` with `{{question}}` (`{{relabelQuestion}}`) and end your turn with the question as your last words. The answer reaches you as your next prompt; then replace `{{question}}` with `{{running}}` (`{{relabelResume}}`) and go on with the steps above.

Do not end your turn in any other way before step 5 is done: a turn that ends with the issue still labelled running counts as an unfinished task.
