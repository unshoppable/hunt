<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Hunt" width="160" height="160">
</p>

<h1 align="center">Hunt</h1>

<p align="center">
  A native desktop client for Claude Code.<br>
  One git worktree per session, a built-in IDE, pull request reviews and a dependency graph of every change.
</p>

<p align="center">
  <a href="https://github.com/unshoppable/hunt"><img alt="Version" src="https://img.shields.io/badge/version-0.1.0-2ea44f?style=for-the-badge"></a>
  <a href="https://tauri.app"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8D8?style=for-the-badge&logo=tauri&logoColor=white"></a>
  <a href="https://react.dev"><img alt="React 19" src="https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB"></a>
  <a href="https://www.rust-lang.org"><img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?style=for-the-badge&logo=rust&logoColor=white"></a>
  <a href="https://agentclientprotocol.com"><img alt="ACP" src="https://img.shields.io/badge/protocol-ACP-8A2BE2?style=for-the-badge"></a>
  <a href="https://www.apple.com/macos"><img alt="macOS" src="https://img.shields.io/badge/platform-macOS-111111?style=for-the-badge&logo=apple&logoColor=white"></a>
</p>

---

## What is Hunt?

Hunt wraps [Claude Code](https://claude.com/claude-code) in a desktop app built on the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The shell is Tauri 2 (Rust), the UI is React 19.

Every session runs in its own git worktree, so the changes of parallel sessions never mix. Sub sessions share
their parent's worktree and are told apart by the files they touched. Around the chat sit the tools you need to
judge what the agent did: a changelist with diffs, a Monaco-based editor with a real language server, a GitHub pull
request review flow, a dependency graph of the change and an editor for the rules, skills and architectural
decision records that steer the agent.

## Features

- **Isolated sessions.** Each session gets a `hunt/<slug>-<id>` worktree; shelve, revert and commit per file.
- **Sub sessions.** Start a background agent in an existing worktree, or ask Claude about a selected diff range.
- **Change attribution.** Sessions sharing a worktree see only their own files; shared files carry a badge.
- **Built-in IDE.** Project tree, Monaco panes with tabs, breadcrumbs, go-to-declaration, usages, inlay hints and
  diagnostics from the TypeScript 7 language server, WebStorm-style semantic coloring and folder colors.
- **Pull request reviews.** Pick an open PR, review its diff against the merge base, draft inline comments in the
  gutter and submit the review through `gh`.
- **Dependency graph.** The agent writes `.hunt/graph.json` for the change; Hunt validates it, fills the gaps from
  import statements and lays it out with ELK inside React Flow. The diagram flags itself as outdated when the
  worktree changes.
- **Guardrails window.** Edit `CLAUDE.md`, `.claude/rules/*.md`, skills and ADRs in one place, with templates for
  new entries.
- **Native windows.** Editor, diff, guardrails and settings open as separate macOS windows that stay in sync.

## Getting started

### Requirements

- macOS
- Node ≥ 20 and a Rust toolchain (`rustup`)
- A Claude Code login (`claude /login`); the agent runs under your subscription
- Optional: the `gh` CLI, logged in, for pull request reviews
- Optional: WebStorm via JetBrains Toolbox, for "Open in WebStorm"

### Run

```sh
npm install
npm run tauri dev
```

### Verify

```sh
npm run check   # typecheck, lint, vitest and cargo test
```

See [CLAUDE.md](CLAUDE.md) for the conventions contributors and coding agents follow in this repository.

## How it works

### Sessions and the agent

`src-tauri/src/acp/` spawns `@agentclientprotocol/claude-agent-acp` per session and forwards every
`session/update` to the UI as the `acp:update` event; permission requests become `acp:permission`.

A sub session is a fresh agent session in the worktree of an existing session. "sub session" on a session in the
sidebar starts one with a title; selecting text on the right side of a diff and choosing "Ask Claude about
selection" in the context menu starts one as a sub chat with the selected lines in its system prompt. Sub sessions
run in the background, are listed under their parent in the sidebar and are removed together with it. Every code
view of the worktree marks the first line of such a selection with a glyph that reopens the sub chat in its popover;
the sub session's chat pane offers "Open in editor" for the selected lines.

The language of every output Hunt asks the agent for on its own (session summaries and titles in
`src-tauri/src/session/summary.rs`, the dependency graph) is the "Agent" setting in the settings dialog, German by
default; the frontend pushes it to `src-tauri/src/preferences.rs` at start and on change.

### Worktrees and changes

`src-tauri/src/git.rs` creates `hunt/<slug>-<id>` worktrees under the app data directory, lists their changes
against the session's diff base (`HEAD`, or the merge base of a reviewed pull request) and supports shelving and
reverting them.

Sessions sharing a worktree tell their changes apart by file: `src-tauri/src/session/attribution.rs` snapshots the
worktree (`git write-tree` through a scratch index) when a tool call that may write starts and finishes, and records
the paths that differ as touched by that session. The changelist of a shared worktree shows only the session's own
files by default ("Show all" lifts the filter); a sub session's own files include those of its parent, so it sees
the parent's changelist plus its own and hides only sibling sub sessions. Unattributed changes count as the
top-level session's; files touched by several sessions carry a "shared" badge because their diff shows every
session's changes. Committing, shelving or reverting a file clears its attribution.

### Pull request reviews

`src-tauri/src/github.rs` lists the open pull requests of a repository and reads one with its conversation through
the `gh` CLI. The "PR review" button of the new-session view (`src/sessions/PullRequestPopover.tsx`) shows them with
a search box; picking one starts the session right away, without a prompt: a worktree on the pull request's branch,
titled after the pull request, with the pull request and the merge base with its target branch stored in the session
(`pullRequest` and `diffBase` in `sessions.json`).

The changelist of such a session compares against that merge base, so it lists the pull request's changes, and its
"Submit review…" button posts a comment, approval or change request through `gh pr review`. The "PR Description" tab
(`src/review/`) renders the pull request's description, comments and reviews like GitHub's conversation view. In its
code views hovering a line shows GitHub's "+" in the gutter (`src/review/addCommentGlyph.ts`); a click opens a
comment box under the line, and drafted comments stay there as cards (`src/review/ReviewCommentZones.tsx`, stored
as `reviewComments` in `sessions.json`) until the review goes out. A draft on a line of a diff hunk (blue "+") is
posted inline through the REST API (`src-tauri/src/session/review.rs`); a draft elsewhere (grey "+") becomes a note
in the review summary with the commented lines as a code block.

### Editor

The "Editor" tab is a small built-in IDE for the worktree: a lazily listed project tree
(`src-tauri/src/workspace.rs`) and Monaco editor panes with tabs and a symbol breadcrumb (`src/ide/`). A folder's
context menu marks it with a color that tints it and everything below it, like WebStorm's file colors; marks are
kept per repository in `src/ide/folderColors.ts`. Files live as `file://<worktree>/…` models.

Hover, inlay hints, diagnostics, the breadcrumb, go-to-declaration and usages come from the TypeScript 7 language
server (`tsgo --lsp`, from the worktree's `node_modules/.bin` or the PATH), one process per worktree managed by
`src-tauri/src/lsp.rs` and bridged through `src/ide/lsp/`. Monaco's bundled TypeScript worker only colors code:
`src/diff/webstormClassifier.ts` assigns every identifier the role WebStorm would (class, interface, instance field,
static method, parameter, global/local variable, …), colored by the user's WebStorm scheme
(`src/diff/webstormScheme.ts`); opening a file also loads its relative imports so imported names get their roles.

| Shortcut | Action |
| --- | --- |
| ⌘click | Go to declaration in the same pane (in the diff: open the file in the editor window) |
| ⇧⌘click | Open the position in WebStorm |
| ⌘E / ⌘R | Move the active tab to the pane on the left / right, creating it when needed |
| ⇧⌘E / ⇧⌘R | Move the active tab to the pane above / below |
| ⌘W / ⇧⌘W | Close the active tab / every tab |
| ⇧⌘2 | Select the file in the project tree |
| ⌘S | Save |
| ⌘P or double shift | "Go to File": fuzzy search over `git ls-files`; `name:12` jumps to line 12 |

### Guardrails

"Guardrails" in the chat header opens a window of its own over the repository's rules (`.claude/rules/*.md`,
`CLAUDE.md`), skills (`.claude/skills/<name>/SKILL.md`) and architectural decision records
(`docs/adr/NNNN-title.md`, or the existing ADR folder), one tab each (`src/guardrails/`). Entries open in a Markdown
editor; "New …" creates a file from a template (ADRs are numbered after the highest existing one), ⌘S or "Save"
writes it.

Opening a session checks that the worktree's root `CLAUDE.md` names the ADR folder and otherwise offers once to
append an "Architectural decisions" section with the `ls`/`grep` lookup (`src/guardrails/adrInstruction.ts`);
without it Claude Code never reads the records. A decline is remembered until the app restarts.

### Dependency graph

The Dependency Graph tab asks the agent (hidden turn, standard prompt in `src-tauri/src/graph.rs`) to write
`.hunt/graph.json` (git-excluded, schema in `src-tauri/src/graph.schema.json`): one node per changed file plus the
unchanged files that explain the change, and one edge per dependency with a label naming what it is for and a
description of how it is used. `src/graph/` validates it, fills pairs the agent left out with edges read from the
import statements (labelled by the target file's role, e.g. `business logic` for `*.service.ts`) and lays it out
with ELK inside React Flow.

The modification time of `graph.json` is the time the diagram was generated; every session records in
`sessions.json` when it last changed worktree files (agent edits via the change attribution, saves in Hunt panes,
revert, shelve, unshelve), and the panel marks the diagram "Outdated" once such a change is newer than the diagram
(`graph_status` command).

## Project layout

| Path | Owns |
| --- | --- |
| `src-tauri/src/acp/` | Agent process per session, ACP event forwarding |
| `src-tauri/src/git.rs` | Worktrees, changelists, shelve and revert |
| `src-tauri/src/github.rs` | Pull requests through `gh` |
| `src-tauri/src/session/` | Session commands, store, attribution, summaries, reviews |
| `src-tauri/src/lsp.rs` | One `tsgo --lsp` process per worktree |
| `src-tauri/src/workspace.rs` | Project tree and file access |
| `src-tauri/src/graph.rs` | Dependency graph prompt and status |
| `src/ipc/` | Every Tauri command, event and shared type |
| `src/state/` | Zustand stores and chat reducers |
| `src/chat/`, `src/diff/`, `src/ide/`, `src/graph/`, `src/guardrails/`, `src/review/`, `src/sessions/`, `src/settings/` | One folder per tab or window |
| `src/ui/` | Primitives shared by every feature |
| `docs/adr/` | Architectural decision records |

## Architectural decisions

Decisions that shape the codebase are recorded in [`docs/adr/`](docs/adr), one file per decision with Context,
Decision and Consequences. Read them before changing the parts they cover.
