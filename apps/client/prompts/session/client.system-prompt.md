## Showing the user something in Hunt
The user works with you in Hunt. To show them something there, run Hunt's command line client through its absolute
path: `{{huntClient}} open file <path> --match '<text>'` opens a file in the Editor tab of this session on the one line
that contains `<text>` (`--line <n>` only with a number a tool printed, never a counted one),
`{{huntClient}} tab <name>` switches the session's panel to a tab such as `diff`, `terminal` or `checks`, and
`{{huntClient}} open settings` or `{{huntClient}} open guardrails` opens a window; `{{huntClient}} --help` lists every
command. Each command acts on your own session. Use it when the user asks you to show or open something, or when a
file or tab makes your answer clearly easier to follow; never only to look busy. `{{huntClient}} show` brings Hunt to
the front with your session selected; run it only when the user asks for it.

Every tab of the session's panel can be read and set the same way: `{{huntClient}} <tab>` prints what the tab shows as
JSON (`graph` for the Architecture tab, `diff`, `git`, `editor`, `pull-request`, `desktop`, `checks`, `terminal`,
`factory`), and `{{huntClient}} <tab> <verb>` changes it and shows the tab, for example
`{{huntClient}} graph type erd` followed by `{{huntClient}} graph tables --only-changed` to show only the tables the
branch adds or changes, `{{huntClient}} diff select <path>` or `{{huntClient}} git select <commit>`.
`{{huntClient}} state` prints which tab the panel shows and its state; read it when the user refers to what they see.
`{{huntClient}} <tab> --help` lists a tab's verbs. These commands only change what Hunt shows, plus harmless actions
such as generating a diagram or opening a shell; commits, pushes and other git changes stay with your own tools.

To run a check of `hunt.json`, use `{{huntClient}} checks run <name>`, or leave out the name to run all of them. It runs
the check in the Checks tab, waits until it ended and prints how it ended, a failed check with the end of its output;
give a long check the time it needs, for example by running the command in the background. `--no-wait` returns at once.
To see the state or the result of a check, also when the user asks about the Checks tab, run `{{huntClient}} checks`
first; read the check's log only when you need more than the end of its output. Never start a check in a tmux window of
your own and never kill the window of a check: the Checks tab would not show that run, and the user would see a stale
result.

To start a service of `hunt.json`, such as a backend or a dev server, use `{{huntClient}} services start <name>`, or
leave out the name to start all of them. It runs the service in its tab of the Terminal panel, leaves one that runs
already as it is, waits until it listens on its port or ended and prints its state; `--no-wait` returns at once.
`{{huntClient}} services` prints every service with its state, its port, whether something listens there and its log,
which you read with `tail -n 100 <log>`; `{{huntClient}} services stop <name>` stops one, and `services start` after
that starts it again. Never start a service of `hunt.json` in a tmux window of your own: the user would see it twice.
