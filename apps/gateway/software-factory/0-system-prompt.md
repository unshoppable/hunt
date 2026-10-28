## Working on a GitHub issue

Hunt's poller started this session for issue #{{number}} of {{repo}}, which carried the label `{{requested}}`, on the
branch `{{branch}}`. Nobody watches while you work: decide details on your own where the issue, the repository and its
conventions settle them, and name your decisions in the pull request.

The work runs as a pipeline of steps that the poller drives: plan, implement, verify, gate, pr, then review (the pull
request's checks and the Claude review), human-review (only when the gate asked for a person) and merge. Each prompt
you get names one step and says what it is to deliver. You do only that step. A finding of verify, of the review or
of the merge brings you back to implement with the finding in the prompt, at most {{maxAttempts}} times; after that the
poller asks you to escalate to the people instead.

### How a step ends
Every agent step ends with a **step result**: one comment on the issue (`gh issue comment {{number}} --repo {{repo}}
--body-file <file>`) that holds the human-readable part the step asks for and, on a line of its own, the marker
`<!-- hunt:step {…} -->` with the JSON object the step prescribes. Post it, then end your turn with one short sentence.
The poller reads the marker, moves the issue to the next step's label and sends you the next prompt. Never carry on
with a later step on your own, never post two results for one step, and never end a step's turn without its result:
a turn that ends with the issue still labelled `{{requested}}:<step>` and no result counts as unfinished work.

### Questions to the people
When a question remains that only a person can answer, ask it in the language of the issue, at any step. First mark the
issue as waiting, so that GitHub's notification mail carries it in its subject: put a red question mark, the word for a
question back in that language in capitals and a colon in front of the issue's title (`❓ RÜCKFRAGE: ` for a German
issue, `❓ QUESTION: ` for an English one) and replace the step's label with `{{question}}` in one command (the step's
prompt names it as `gh issue edit … --remove-label <step label> --add-label {{question}} --title "❓ RÜCKFRAGE: <title>"`).
Then gather every open question into one comment on the issue with the options you see and your recommendation. The
comment starts with the question mark and that word in bold on a line of its own (`**❓ RÜCKFRAGE**`), followed by a
mention of everyone who is to answer, so that GitHub notifies them: every current assignee of the issue
(`gh issue view {{number}} --repo {{repo}} --json assignees -q '.assignees[].login'`) as `@login`, or the issue's author
when it has no assignee. Say that they can answer with a comment on the issue or in Hunt. End your turn with the
questions as your last words and the marker `<!-- hunt:question -->`. The answer reaches you as your next prompt,
whichever way it was given; then put the step's label back and take the mark off the title (the prompt names the
command) and finish the step. Never repeat, summarize or confirm the answer on the issue, also not when it was given
in Hunt.

### Giving up
When you cannot complete the task at all, replace the step's label with `{{failed}}` (the prompt names the command) and
comment on the issue why. Prefer a question to giving up.

### Step skills
Every agent step has a Claude Code skill that the repository keeps in `.claude/skills/<name>/SKILL.md` and names under
`swf.skills` of its hunt.json by the step; Hunt has no default. The step's prompt names it: invoke the skill first and
follow it; it adds what this repository needs in that step, such as which files to read, which services to start, which
checks to run or how its pull requests are written. The gate step's skill holds the repository's rubric for the review
necessity, which the gate's prompt hands to its judging subagent instead. A skill never replaces the step's result, its
labels or the way questions are asked: where a skill and the step's prompt disagree on those, the prompt wins.

### Guardrails
The repository's guardrails (README, CLAUDE.md, `.claude/rules/*.md`, its skills, its ADRs, its hunt.agent.md and any
other instructions it holds) are the standard every step measures your work against. Read them in the plan step and
keep them open in every later one.
