# Prompt files of the swf poller

Prompts `hunt-swf` sends to the agent of a session it started for a GitHub issue (`src/swf.ts`). The files are compiled
in verbatim (`?raw` imports), so they hold nothing but the prompt text; this file says when each is sent.
`{{placeholders}}` are filled by `fillPrompt` (`libs/domain/src/prompts.ts`) in `src/swfPlan.ts`, which throws on a placeholder without a value.
The label placeholders (`requested`, `running`, `question`, `done`, `failed`) are the labels of the repository's swf
workflow; `relabelDone`, `relabelFailed`, `relabelQuestion` and `relabelResume` are the `gh issue edit` commands that
move the issue from one label to the next (`labelValues`); the prompts append `--title` to the question and resume
commands, which put a red question mark and the word for a question back in front of the issue's title and take it off again.

| File | When | Where it lands |
| --- | --- | --- |
| `swf.system-prompt.md` | the start of every poller session (`swfSystemPrompt`) | system prompt, after the shared remote, Git and question parts of `libs/domain/prompts/` and before the services section (`remoteSystemPrompt`). The steps of the workflow: read the issue and the repository's guardrails, ask open questions, comment a plan, loop over implement, check and self-review (at most three passes), open the pull request and watch its checks, clean up and set the label. `{{number}}`, `{{repo}}`, `{{branch}}` and the label placeholders |
| `swf-first.user-prompt.md` | the first prompt of the session, sent through the relay once the VM runs (`firstPrompt`) | chat message with the issue (`{{title}}`, `{{url}}`, `{{author}}`, `{{createdAt}}`, `{{body}}`), all its comments (`{{comments}}`, `(none)` without any) and `{{branch}}`; sends the agent to the steps of the system prompt |
| `swf-nudge.user-prompt.md` | a poll finds the agent's turn ended while the issue is still labelled running: no pull request link, none of done, question or failed set (`nudgePrompt`); sent once per session, never while a Hunt desktop is connected | chat message reminding the agent to finish or set a label; when the next turn ends the same way, the poller marks the issue as failed itself |
| `swf-answer.user-prompt.md` | a poll finds a comment by someone other than the app's bot user after the agent's question while the issue is labelled question (`newAnswers`, `answerPrompt`); each answer is sent once, never while the relay is busy or a Hunt desktop is connected; a stopped VM is started first | chat message with the new comments (`{{comments}}`) telling the agent to take the label back to running (`{{relabelResume}}`) and go on with the step it stopped at |
