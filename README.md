# Hunt

Desktop client for Claude Code built on the Agent Client Protocol (ACP).
Tauri 2 (Rust) shell, React UI. Each session runs in its own git worktree, so diffs never mix; sub sessions share their parent's worktree and are told apart by file.

## Requirements

- macOS, Node ≥ 20, Rust toolchain (`rustup`), WebStorm via JetBrains Toolbox (for "Open in WebStorm")
- A Claude Code login (`claude /login`); the agent runs under your subscription

## Run

```sh
npm install
npm run tauri dev
```

## How it works

- `src-tauri/src/acp/` spawns `@agentclientprotocol/claude-agent-acp` per session and forwards every
  `session/update` to the UI as the `acp:update` event; permission requests become `acp:permission`.
- `src-tauri/src/git.rs` creates `hunt/<slug>-<id>` worktrees under the app data directory, lists their changes
  against the session's diff base (`HEAD`, or the merge base of a reviewed pull request) and supports shelving and
  reverting them.
- `src-tauri/src/github.rs` lists the open pull requests of a repository and reads one with its conversation through
  the `gh` CLI (installed and logged in by the user). The "PR review" button of the new-session view
  (`src/sessions/PullRequestPopover.tsx`) shows them with a search box; picking one starts the session right away,
  without a prompt: a worktree on the pull request's branch, titled after the pull request, with the pull request and
  the merge base with its target branch stored in the session (`pullRequest` and `diffBase` in `sessions.json`). The
  changelist of such a session compares against that merge base, so it lists the pull request's changes, and its
  "Submit review…" button posts a comment, approval or change request through `gh pr review`. Such a session shows a
  GitHub icon in the sidebar and the prompt toolbar, and the "PR Description" tab (`src/review/`) renders the pull
  request's description, comments and reviews like GitHub's conversation view. In its code views (diff pane, editor
  pane and their windows) hovering a line shows GitHub's "+" in the gutter (`src/review/addCommentGlyph.ts`); a click
  opens a comment box under the line, and drafted comments stay there as cards (`src/review/ReviewCommentZones.tsx`,
  stored as `reviewComments` of the top-level session in `sessions.json`) until the review goes out. A draft on a
  line of a diff hunk (changed lines and three context lines, blue "+") is posted inline through the REST API
  (`gh api … /pulls/{n}/reviews`, `src-tauri/src/session/review.rs`); a draft elsewhere (grey "+") becomes a note in
  the review summary with the commented lines as a code block.
- A sub session is a fresh agent session in the worktree of an existing session. "sub session" on a session in
  the sidebar starts one with a title; selecting text on the right side of a diff and choosing "Ask Claude about
  selection" in the context menu starts one as a sub chat with the selected lines in its system prompt. Sub
  sessions run in the background, are listed under their parent in the sidebar and are removed together with it.
  Every code view of the worktree (diff, editor, their windows; in the parent and in every sub session) marks the
  first line of such a selection with a glyph that reopens the sub chat in its popover; the sub session's chat
  pane offers "Open in editor" for the selected lines.
- Sessions sharing a worktree tell their changes apart by file: `src-tauri/src/session/attribution.rs` snapshots
  the worktree (`git write-tree` through a scratch index) when a tool call that may write starts and finishes,
  and records the paths that differ as touched by that session. The changelist of a shared worktree shows only the
  session's own files by default ("Show all" lifts the filter); a sub session's own files include those of its
  parent, so it sees the parent's changelist plus its own and hides only sibling sub sessions. Unattributed changes
  count as the top-level session's (and therefore as every sub session's); files touched by several sessions carry
  a "shared" badge because their diff shows every session's changes. Committing, shelving or reverting a file
  clears its attribution.
- The "Editor" tab is a small built-in IDE for the worktree: a lazily listed project tree (`src-tauri/src/workspace.rs`)
  and Monaco editor panes with tabs and a symbol breadcrumb (`src/ide/`). A folder's context menu marks it with a
  color that tints it and everything below it, like WebStorm's file colors; marks are kept per repository in
  `src/ide/folderColors.ts`. Files live as `file://<worktree>/…` models.
  Hover, inlay hints, diagnostics, the breadcrumb, go-to-declaration and usages come from the TypeScript 7 language
  server (`tsgo --lsp`, from the worktree's `node_modules/.bin` or the PATH), one process per worktree managed by
  `src-tauri/src/lsp.rs` and bridged through `src/ide/lsp/`. Monaco's bundled TypeScript worker only colors code:
  `src/diff/webstormClassifier.ts` assigns every identifier the role WebStorm would (class, interface, instance field,
  static method, parameter, global/local variable, …), colored by the user's WebStorm scheme (`src/diff/webstormScheme.ts`);
  opening a file also loads its relative imports so imported names get their roles.
  ⌘click goes to the declaration in the same pane, ⇧⌘click opens the position in WebStorm (also in the diff, where
  ⌘click opens the file in the session's editor window: the same editor in a window of its own, `src/ide/EditorWindow.tsx`). ⌘E / ⌘R move the active tab to the pane on the left / right and ⇧⌘E / ⇧⌘R
  to the pane above / below, creating the pane when there is none; ⌘W closes the active tab, ⇧⌘W every tab; ⇧⌘2 selects the file in the project tree; ⌘S saves. ⌘P or double shift opens "Go to File"
  (`src/ide/FileSearchDialog.tsx`): fuzzy search over every project file (`git ls-files`, ignored files excluded) that
  opens the pick in the editor tab or, from another tab, in the editor window; `name:12` jumps to line 12.
- "Guardrails" in the chat header opens a window of its own over the repository's rules (`.claude/rules/*.md`, `CLAUDE.md`), skills
  (`.claude/skills/<name>/SKILL.md`) and architectural decision records (`docs/adr/NNNN-title.md`, or the existing ADR folder),
  one tab each (`src/guardrails/`). Entries open in a Markdown editor; "New …" creates a file from a template (ADRs are
  numbered after the highest existing one), ⌘S or "Save" writes it.
  Opening a session checks that the worktree's root `CLAUDE.md` names the ADR folder and otherwise offers once to append an
  "Architectural decisions" section with the `ls`/`grep` lookup (`src/guardrails/adrInstruction.ts`); without it Claude Code
  never reads the records. A decline is remembered until the app restarts.
- The Dependency Graph tab asks the agent (hidden turn, standard prompt in `src-tauri/src/graph.rs`) to write
  `.hunt/graph.json` (git-excluded, schema in `src-tauri/src/graph.schema.json`): one node per changed file plus
  the unchanged files that explain the change, and one edge per dependency with a label naming what it is for and a
  description of how it is used and what for. `src/graph/` validates it, fills pairs the agent left out with edges
  read from the import statements (labelled by the target file's role, e.g. `business logic` for `*.service.ts`)
  and lays it out with ELK inside React Flow. The modification time of `graph.json` is the time the diagram was
  generated; every session records in `sessions.json` when it last changed worktree files (agent edits via the
  change attribution, saves in Hunt panes, revert, shelve, unshelve), and the panel marks the diagram
  "Outdated" once such a change is newer than the diagram (`graph_status` command). The language of this and every other output Hunt asks the agent
  for on its own (session summaries and titles, `src-tauri/src/session/summary.rs`) is the "Agent" setting in the
  settings dialog, German by default; the frontend pushes it to `src-tauri/src/preferences.rs` at start and on change.
