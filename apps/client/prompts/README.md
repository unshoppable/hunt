# Prompt files of the desktop app

Prompts the app sends to Claude Code. The files are compiled in verbatim (`include_str!` in Rust, `?raw` imports in TS),
so they hold nothing but the prompt text; this file says who sends which of them and when. `<name>.system-prompt.md`
extends Claude Code's system prompt through the ACP `systemPrompt` meta, `<name>.user-prompt.md` is a message Hunt sends
into the chat. `{{placeholders}}` are filled by `fill_prompt` in `src-tauri/src/graph.rs`.

| File | When | Where it lands |
| --- | --- | --- |
| `response-style.system-prompt.md` | every session, unless the user cleared or edited the prompt in Settings | first part of the system prompt addition (`system_prompt_append` in `src-tauri/src/acp/connection.rs`). `src-tauri/src/preferences.rs` and `src/state/settings.ts` import the same file as the default, so the settings dialog can tell a default from an edit |
| `guardrail-offer.system-prompt.md` | every session | system prompt addition, after the response style. Asks the agent to end a reply that settles or uncovers something worth a guardrail, and that no existing guardrail records, with `<!-- hunt:guardrail … -->` (before a question marker), which `src/chat/guardrailSuggestion.ts` turns into an offer to record it |
| `handoff-start.user-prompt.md` | right after a handoff, when `hunt.json` declares services and none runs or starts and no user prompt ran or queued meanwhile (`startServicesAfterHandoff` in `src/state/store.ts`) | chat message, which the chat shows as a one-line notice instead of a bubble (`src/chat/huntPromptNotice.ts`); the agent starts the services the task needs, as `hunt.agent.md` describes, and nothing else |
| `diagram/diagram.system-prompt.md` | every session, filled with the AI language | system prompt addition, after the component-diagram instructions `graph.rs` holds (`graph::system_prompt`); the rules shared by the five shape diagrams and the JSON schema `diagram.schema.json` |
| `diagram/diagram-<type>.user-prompt.md` | a click on *Generate* in the Architecture tab for `c4-context`, `c4-container`, `states`, `erd` or `process` (`graph::refresh_prompt`, command `refresh_graph`) | chat message as a hidden turn; `{{diffBase}}` is the session's diff base (`HEAD` or the merge base of a reviewed pull request), `{{language}}` the AI language, `{{englishTerms}}` the rule to keep English technical terms, `{{instructions}}` the user's free text for this run or `(none)` |

The component diagram (`dependencies`) has no file: its system prompt and refresh prompt are the string constants in
`graph.rs`. The shared parts a remote session gets on top (`libs/domain/prompts/`) are described there.
