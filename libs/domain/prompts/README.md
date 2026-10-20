# Shared prompt files

System-prompt parts that both the desktop app and the gateway's poller append to Claude Code's system prompt of a
remote session. The files are compiled in verbatim (`include_str!` in `apps/client/src-tauri/src/session/commands.rs` and
`acp/connection.rs`, `?raw` imports in `apps/gateway/src/swf.ts`), so they hold nothing but the prompt text; this file
says who sends which of them and when. Only `sessions.system-prompt.md` carries a `{{placeholder}}`, filled by
`fill_prompt` in `src-tauri/src/graph.rs` and `fillPrompt` in `apps/gateway/src/swfPlan.ts`.

| File | Sent by | When | Where it lands |
| --- | --- | --- | --- |
| `remote.system-prompt.md` | app, poller | every session that runs on a session VM (handoff, reconnect, poller start) | system prompt, after the app's usual addition (`remote_system_prompt`), first part of the poller's (`remoteSystemPrompt` in `swfPlan.ts`); tells the agent it works on a VM, how to run the app's processes in tmux and that the user brings commits back |
| `git-push.system-prompt.md` | app, poller | a remote session whose VM holds a GitHub token (the user's, or the poller's) | right after the remote part; the agent may push and open pull requests |
| `git-local.system-prompt.md` | app | a remote session handed off without a GitHub token | in place of `git-push`; the agent commits locally and does not push |
| `question.system-prompt.md` | app, poller | every session, local and remote | app: `system_prompt_append` in `acp/connection.rs`; poller: after the Git part. Asks the agent to end a reply that waits for the user with `<!-- hunt:question -->`, which `libs/domain/src/question.ts` (the app's chat and the relay's status) and the poller's label handling detect |
| `sessions.system-prompt.md` | app, poller | every session, local and remote; `{{huntSessionId}}` is the agent's own Hunt session id | app: after the question part; poller: after the question part. Points the agent at `.hunt/sessions.md`, the file on the sessions that share its worktree (`src-tauri/src/session/related.rs`), and says how to read a transcript it names |

The app composes its remote system prompt as: its usual addition (`apps/client/prompts/`, see the README there), the
remote part, the Git part, the services section `hunt-ctl session-config` writes and the repository's `hunt.agent.md`. The
poller has no desktop settings and composes: remote part, `git-push`, question part, sessions part, its swf workflow
(`apps/gateway/prompts/`), services section, `hunt.agent.md`.
