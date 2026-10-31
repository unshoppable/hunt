# Prompt files of the desktop app

Prompts the app sends to Claude Code. The files are compiled in verbatim (`include_str!` in Rust, `?raw` imports in TS),
so they hold nothing but the prompt text; this file says who sends which of them and when, one section per folder. `<name>.system-prompt.md`
extends Claude Code's system prompt through the ACP `systemPrompt` meta, `<name>.user-prompt.md` is a message Hunt sends
into the chat, `<name>.claude-md.md` a section Hunt adds to the CLAUDE.md of the user's repository, `<name>.readme.md`
a README Hunt writes into a guardrail folder of it, `<name>.skill.md` a Claude Code skill Hunt writes into it. `{{placeholders}}` are filled by `fill_prompt` in
`src-tauri/src/graph/graph.rs` and `fillPrompt` in `libs/domain/src/shared/prompts.utils.ts`, those of the READMEs by `guardrailReadme` in `src/guardrails/guardrail-readmes.utils.ts`.

## `session/`

Parts of the system prompt addition every session gets; each row says after which part it comes.

| File | When | Where it lands |
| --- | --- | --- |
| `response-style.system-prompt.md` | every session, unless the user cleared or edited the prompt in Settings | first part of the system prompt addition (`system_prompt_append` in `src-tauri/src/agent/acp/connection.rs`). `src-tauri/src/platform/preferences.rs` and `src/settings/settings.store.ts` import the same file as the default, so the settings dialog can tell a default from an edit |
| `change-references.system-prompt.md` | every session | system prompt addition, after the guardrail offer. Asks the agent to end a reply that changed files with `<!-- hunt:changes … -->`, at most four `path:line` places, most important first, which `src/chat/change-references.utils.ts` turns into rows with an "Open in editor" button below the reply |
| `code-locations.system-prompt.md` | every session | system prompt addition, after the change references. Asks the agent to put `path:line` after the language of a fenced code block that shows a file's lines, which `MarkdownCodeBlock` in `src/chat/messages/MessageList.tsx` shows as a header row with an "Open in editor" button above the code, to show a change of a file as one `diff` block with that place, which it shows as a unified diff numbered from the place (`src/chat/messages/diff-fence.utils.ts`), and to link every file and declaration it names in prose as ``[`name`](path:line)``, which `MarkdownText` there shows as a link that opens the editor |
| `terminals.system-prompt.md` | every session whose agent runs on this Mac (local sessions and sub chats) | system prompt addition, after the shared sessions part (`system_prompt_append` in `src-tauri/src/agent/acp/connection.rs`); `{{tmux}}` is the absolute path of the worktree's `.hunt/tmux` (`src-tauri/src/terminal/tmux.rs`). Asks the agent to run long-running processes in windows of the family's tmux session `app`, whose output lands in `.hunt/logs/desktop/<name>.log`, and to leave the windows of other sessions (`@hunt-session`) alone |
| `browser.system-prompt.md` | every session whose agent runs on this Mac (local sessions and sub chats) | system prompt addition, after the terminals part (`system_prompt_append` in `src-tauri/src/agent/acp/connection.rs`). Points the agent to the tools of the MCP server `playwright` (`scripts/browserMcp.mjs`) for the app under development: they drive the session's own Chrome window, which Hunt starts at the first browser tool call and the user watches; sign-ins and CAPTCHAs are left to the user in that window, and annotations the user makes there arrive with the next prompt. Every other site goes to Claude in Chrome when its tools are available |
| `client.system-prompt.md` | every session whose agent runs on this Mac (local sessions and sub chats) | system prompt addition, after the browser part (`system_prompt_append` in `src-tauri/src/agent/acp/connection.rs`); `{{huntClient}}` is the absolute path of the worktree's `.hunt/hunt-client` (`src-tauri/src/platform/control.rs`). Tells the agent how to show the user a file, a tab of its session or a window through `hunt-client` (`scripts/huntClient.mjs`), which the main window runs (`src/control/control-commands.hook.ts`), and to bring Hunt to the front only when asked |
| `workspace-worktree.system-prompt.md`, `workspace-checkout.system-prompt.md` | every session whose agent runs on this Mac (local sessions and sub chats), the first for one in a worktree Hunt created, the second for one in the repository's own checkout (`workspace` of the session record, which a sub chat takes from its parent) | system prompt addition, after the client part (`workspace_prompt` in `src-tauri/src/agent/acp/connection.rs`); `{{branch}}` is the branch of the session's worktree. Tells the agent that the workspace the user chose when starting the session holds for the session and its sub chats, and that it never creates a worktree or branch, switches branches or suggests either unless the user asks |

## `guardrails/`

The guardrail offer, the guardrail skill and its chat, the files Hunt writes into the guardrail folders of the user's repository and the task of a lint-rule chat.

| File | When | Where it lands |
| --- | --- | --- |
| `guardrail-offer.system-prompt.md` | every session | system prompt addition, after the response style (`guardrail_skill::offer_prompt` in `src-tauri/src/agent/guardrail_skill.rs`). Asks the agent to end a reply that settles or uncovers knowledge worth a guardrail with `<!-- hunt:guardrail … -->` (before a question marker), which `src/chat/guardrail/guardrail-suggestion.utils.ts` turns into an offer to record it. `{{skillName}}` and `{{skillFile}}` are the repository's guardrail skill (`guardrailSkill` of hunt.json, default `guardrail`), `{{criteria}}` and `{{kinds}}` the text between the `hunt:criteria` and the `hunt:kinds` comments of its SKILL.md in the local worktree, each taken from `guardrail.skill.md` (filled with the ADR folder of hunt.json) when the worktree is unknown (an agent on a session VM) or the file lacks that pair |
| `guardrail.skill.md` | a session start in a worktree whose guardrail skill file `.claude/skills/<name>/SKILL.md` is missing (`ensure_guardrail_skill` in `src-tauri/src/session/commands/mod.rs`) | that file, as a change of the session; the skill the "Guardrail" button invokes: it qualifies the lesson (the criteria between the `hunt:criteria` comments, which the offer quotes), greps the declines and the existing guardrails, picks the kind (by the list between the `hunt:kinds` comments, which the offer quotes as well) and writes it. `{{skillName}}` is the skill's name, `{{adrDir}}` the ADR folder of hunt.json, `{{declinesFile}}` its declines file (`declinedGuardrailsFile`, default `.claude/declined-guardrails.jsonl`). An existing file is never touched |
| `guardrail-chat.system-prompt.md` | a click on the "Guardrail" button of the chat (`openGuardrailChat` in `src/chat/ChatPanel.tsx`) | the task of that sub chat, in its system prompt addition (`SelectionContext::to_system_prompt` in `src-tauri/src/session/store.rs`); tells the agent to follow the `/{{skillName}}` skill (`{{skillFile}}`) the prefilled first message invokes, with `{{transcript}}`, the conversation of the session, as context |
| `declined-guardrails.claude-md.md` | the first time the user declines a suggested guardrail in a repository whose CLAUDE.md does not name its declines file yet (`declinedGuardrailsFile` of hunt.json, default `.claude/declined-guardrails.jsonl`) (`src-tauri/src/agent/declined_guardrails.rs`, command `decline_guardrail`) | appended to the worktree's `CLAUDE.md` (else `.claude/CLAUDE.md`, else a new `CLAUDE.md`) as a change of the session; tells every agent to grep the declines before it suggests a guardrail; `{{declinesFile}}` is the declines file |
| `rules.readme.md`, `adr.readme.md` | once the rules folder `.claude/rules` or the ADR folder (`adrDir` of hunt.json, default `.claude/resources/adrs`) holds a guardrail but no `README.md`; checked when a local session opens, after every agent edit in its worktree and whenever the Guardrails window lists (`ensureGuardrailReadmes` in `src/guardrails/guardrail-readmes.utils.ts`) | `README.md` of that folder, as a change of the session; says when a guardrail is a rule and when an ADR, and the ADR README also when a decision is worth an ADR and that a replaced one is deleted; `{{ruleDir}}` and `{{adrDir}}` are the configured folders. The rules README has a `paths:` front matter, so Claude Code loads it only while it works on a rule |
| `lint-rule.system-prompt.md` | a click on *Agent* at a rule of the Lint rules tab of the Guardrails window (`lintTask` in `src/guardrails/lint-rules.utils.ts`) | the task of that sub chat, in its system prompt addition (`SelectionContext::to_system_prompt` in `src-tauri/src/session/store.rs`); `{{ruleId}}` is the rule, `{{uses}}` a list of the configs, globs and severities that set it. The chat's selection is the first of those configs, whose content every message carries |

## `swf/`

The skill templates of the agent steps of the swf pipeline.

| File | When | Where it lands |
| --- | --- | --- |
| `swf-plan.skill.md`, `swf-implement.skill.md`, `swf-verify.skill.md`, `swf-gate.skill.md`, `swf-pr.skill.md` | a click on *Create* in the dialog that opening a local session shows when the worktree's hunt.json has an `swf` section and an agent step of the swf pipeline lacks its entry in `swf.skills` or the skill file of its name (`ensureSwfSkills` in `src/guardrails/swf-skills.utils.ts`, command `create_swf_skills`, `src-tauri/src/agent/swf_skills.rs`); the dialog lists each step with what it lacks, and a decline holds until the app restarts | `.claude/skills/<name>/SKILL.md` of each step whose file is missing, as a change of the session; `<name>` is the step's entry in `swf.skills` of hunt.json, for a step without one the proposed `swf-<step>` (`proposedSwfSkill` in `src/guardrails/guardrail-config.utils.ts`; there is no runtime default: a missing entry is a hunt.json problem the session VM reports), which the click also writes into `swf.skills` of hunt.json, as a change of the session too. `{{skillName}}` is that name. The poller's step prompt tells the agent to invoke the skill first; the gate step hands its skill to the judging subagent as the rubric. Each template says what its step does and what the skill adds, and leaves the repository's part as `TODO:` lines under "This repository"; the gate's "Review necessity" starts with Hunt's default rubric. An existing entry and an existing file are never touched |

## `checks/`

Messages of the Checks tab.

| File | When | Where it lands |
| --- | --- | --- |
| `check-failed.user-prompt.md` | a click on *Send to agent* at a failed check in the Checks tab (`sendFailure` in `src/checks/checks.store.ts`) | chat message; `{{name}}`, `{{command}}` and `{{exitCode}}` describe the check, `{{folder}}` is the folder it ran in, `{{output}}` the end of its output without escape sequences (`failureExcerpt` in `src/checks/checks.utils.ts`) |
| `checks-setup.user-prompt.md` | a click on *Set up checks* in the Checks tab of a session whose hunt.json declares none | chat message; the agent writes the `checks` section of hunt.json from the repository's scripts and CI |

## `ide/`

Tasks of the sub chats of the editor's project tree.

| File | When | Where it lands |
| --- | --- | --- |
| `project-tree-file.system-prompt.md`, `project-tree-folder.system-prompt.md` | a click on the agent button of a file or folder row in the editor's project tree that has no sub chat about it yet (`askAgent` in `src/ide/IdePanel.tsx`) | the task of that sub chat, in its system prompt addition (`SelectionContext::to_system_prompt` in `src-tauri/src/session/store.rs`); `{{path}}` is the worktree-relative path of the row. Every message of a file chat carries the file's current content |

## `chat/`

Messages Hunt puts into the chat on its own.

| File | When | Where it lands |
| --- | --- | --- |
| `handoff-start.user-prompt.md` | right after a handoff, when `hunt.json` declares services and none runs or starts and no user prompt ran or queued meanwhile (`startServicesAfterHandoff` in `src/sessions/remote/remote-session.store-slice.ts`) | chat message, which the chat shows as a one-line notice instead of a bubble (`src/chat/hunt-prompt-notice.utils.ts`); the agent starts the services the task needs, as `hunt.agent.md` describes, and nothing else |
| `browser-annotations.user-prompt.md` | the next prompt sent from a session's composer while it shows annotations of the review widget, which a remote session's status channel (`src-tauri/src/session/relay_watch.rs`) or a local session's Chrome (`src-tauri/src/agent/browser.rs`) delivered (`review:annotation`); a slash command leaves them for the prompt after it (`promptWithAnnotations` in `src/chat/prompt/annotation-prompt.utils.ts`, called by `src/chat/prompt/PromptInput.tsx`) | start of the chat message, before the user's text, which may be empty; `{{annotations}}` is one Markdown block per annotation with its comment, page, selector, source location, text, box, styles and HTML |

## `diagram/`

The prompts of the background diagram agent.

| File | When | Where it lands |
| --- | --- | --- |
| `diagram.system-prompt.md` | every diagram generation, filled with the AI language | system prompt addition of the background diagram agent (`--append-system-prompt` of the `claude -p` process in `src-tauri/src/session/diagram_agent.rs`), after the component-diagram instructions `graph/graph.rs` holds (`graph::system_prompt`); the rules shared by the five shape diagrams and the JSON schema `diagram.schema.json`. The chat agent of a session does not get it |
| `diagram-<type>.user-prompt.md` | a click on *Generate* in the Architecture tab for `c4-context`, `c4-container`, `states`, `erd` or `process` (`graph::refresh_prompt`, command `refresh_graph`) | the prompt of the background diagram agent, sent through its stdin; the chat shows nothing of it. `{{diffBase}}` is the session's diff base (`HEAD` or the merge base of a reviewed pull request), `{{language}}` the AI language, `{{englishTerms}}` the rule to keep English technical terms, `{{instructions}}` the user's free text for this run or `(none)` |

The component diagram (`dependencies`) has no file: its system prompt and refresh prompt are the string constants in
`graph/graph.rs`. The shared parts a remote session gets on top (`libs/domain/prompts/`) are described there.