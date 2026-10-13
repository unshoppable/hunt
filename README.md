<h3 align="center">
  <img src="src-tauri/icons/icon.png" width="100" alt="Hunt logo"/><br/>
  <img src="docs/assets/transparent.png" height="30" width="0px"/>
  Hunt
  <img src="docs/assets/transparent.png" height="30" width="0px"/>
</h3>

<h6 align="center">
  <a href="#-features">Features</a>
  ·
  <a href="#install">Install</a>
  ·
  <a href="#-how-it-works">How it works</a>
  ·
  <a href="https://github.com/unshoppable/hunt/releases">Releases</a>
</h6>

<p align="center">
  <img src="docs/assets/palette.svg" width="400" alt=""/>
</p>

<p align="center">
  <a href="https://github.com/unshoppable/hunt/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/unshoppable/hunt?style=for-the-badge&labelColor=363a4f&color=a6da95&logo=github&logoColor=cad3f5"></a>
  <a href="https://www.apple.com/macos"><img alt="macOS" src="https://img.shields.io/badge/platform-macOS-b7bdf8?style=for-the-badge&labelColor=363a4f&logo=apple&logoColor=cad3f5"></a>
  <a href="https://tauri.app"><img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-91d7e3?style=for-the-badge&labelColor=363a4f&logo=tauri&logoColor=cad3f5"></a>
  <a href="https://react.dev"><img alt="React 19" src="https://img.shields.io/badge/React-19-8aadf4?style=for-the-badge&labelColor=363a4f&logo=react&logoColor=cad3f5"></a>
  <a href="https://agentclientprotocol.com"><img alt="ACP" src="https://img.shields.io/badge/protocol-ACP-c6a0f6?style=for-the-badge&labelColor=363a4f"></a>
</p>

&nbsp;

<p align="center">
  A native desktop client for Claude Code. One git worktree per session, a built-in IDE, pull request reviews and a
  dependency graph of every change.
</p>

&nbsp;

### 🧭 What is Hunt?

Hunt wraps [Claude Code](https://claude.com/claude-code) in a desktop app built on the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The shell is Tauri 2 (Rust), the UI is React 19.

Every session runs in its own git worktree, so the changes of parallel sessions never mix; a session can instead run
in the repository's own checkout, where the changelist shows only what the session changed. Sub sessions share
their parent's worktree and are told apart by the files they touched. Around the chat sit the tools you need to
judge what the agent did: a changelist with diffs, a Monaco-based editor with a real language server, a GitHub pull
request review flow, a dependency graph of the change and an editor for the rules, skills and architectural
decision records that steer the agent.

&nbsp;

### ✨ Features

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

&nbsp;

### 🚀 Getting started

#### Install

Download the latest DMG from the [releases page](https://github.com/unshoppable/hunt/releases/latest), open it and
drag Hunt into Applications. Hunt ships for Apple Silicon only.
The app is not signed yet: on first launch right-click it and choose *Open*, or run `xattr -cr /Applications/Hunt.app`.

#### Update

Hunt checks the releases page once per launch and shows a dot on the gear button when a newer version exists.
*Settings → Updates* downloads and installs it; the new version runs after *Restart now* or the next launch.

#### Requirements

- macOS
- Node ≥ 20 and a Rust toolchain (`rustup`)
- A Claude Code login (`claude /login`); the agent runs under your subscription
- Optional: the `gh` CLI, logged in, for pull request reviews
- Optional: WebStorm via JetBrains Toolbox, for "Open in WebStorm"

#### Run

```sh
npm install
npm run tauri dev
```

#### Verify

```sh
npm run check   # typecheck, lint, vitest and cargo test
```

#### Release

```sh
npm run tauri build -- --bundles dmg   # local DMG in src-tauri/target/release/bundle/dmg/
```

Releases are cut from *Actions → Release → Run workflow* on `master` ([`release.yml`](.github/workflows/release.yml)).
The run derives the next version from the Conventional Commits since the last tag (`feat` → minor, `fix`/`perf` →
patch, `!` or `BREAKING CHANGE` → major; the `bump` input overrides it), rewrites every version file, commits and tags,
builds the Apple Silicon DMG plus the updater artifacts (`Hunt.app.tar.gz`, its `.sig` and `latest.json`) and publishes
the GitHub Release once the build is green. Publishing is what makes running installs offer the update: the in-app
updater reads `latest.json` of the latest *published* release. `node scripts/release/release.ts --dry-run` shows what
the next run would do.

The updater artifacts are signed with the key whose public half is in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`); the workflow reads the private key from the repository secrets `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. A local build only produces them with the same two variables set and
`--config src-tauri/tauri.release.conf.json`. Losing the key means shipping a new key with a DMG that users install by hand.

See [CLAUDE.md](CLAUDE.md) for the conventions contributors and coding agents follow in this repository.

&nbsp;

### 🧩 How it works

#### Sessions and the agent

`src-tauri/src/acp/` spawns `@agentclientprotocol/claude-agent-acp` per session and forwards every
`session/update` to the UI as the `acp:update` event; permission requests become `acp:permission`.

A session starts in the start view of the chat pane ("New" in the sidebar), which preselects the repository used
last. Choosing a repository there, from the folder dialog or the list of recently used ones, creates the session right
away, so the sidebar lists it and the diff, editor and graph panes work before anything was asked; such a session is
titled after its repository until its first prompt names it (`rename_session`). With the preselected repository the
first prompt creates the session and titles it; "PR review" starts a review session on a pull request's branch.

A sub session is a fresh agent session in the worktree of an existing session. "sub session" on a session in the
sidebar starts one with a title; selecting text on the right side of a diff and choosing "Ask Claude about
selection" in the context menu starts one as a sub chat with the selected lines in its system prompt. Sub sessions
run in the background, are listed under their parent in the sidebar and are removed together with it. Every code
view of the worktree marks the first line of such a selection with a button right of the line number that reopens the
sub chat in its popover; the sub session's chat pane offers "Open in editor" for the selected lines.

The "Agent" page of the settings dialog holds what Hunt tells the agent on its own: the language of every output
Hunt asks for itself (session summaries and titles in `src-tauri/src/session/summary.rs`, the dependency graph),
German by default, and the system prompt addition of every new session, by default the response-style instructions
in `prompts/response-style.md` (plain language for software engineers). The frontend pushes both to
`src-tauri/src/preferences.rs` at start and on change; `src-tauri/src/acp/connection.rs` appends the prompt, the
diagram instructions and the selection context of a sub session to Claude Code's system prompt via the ACP
`systemPrompt` meta.

#### Worktrees and changes

`src-tauri/src/git.rs` creates `hunt/<slug>-<id>` worktrees under the app data directory, lists their changes
against the session's diff base (`HEAD`, or the merge base of a reviewed pull request) and supports shelving and
reverting them.

A new worktree has no `node_modules`, so `src-tauri/src/session/dependencies.rs` prepares it in the background:
when the repository has an installed `node_modules`, it is cloned with one APFS `clonefile` call (copy-on-write,
seconds instead of minutes, no extra disk space); when the worktree's lockfile differs from the repository's, or
there is nothing to clone, the package manager the lockfile belongs to (npm, pnpm, yarn or bun) installs on top.
The editor shows the progress above its panes and the language server restarts once the modules exist.

Sessions sharing a worktree tell their changes apart by file: `src-tauri/src/session/attribution.rs` snapshots the
worktree (`git write-tree` through a scratch index) when a tool call that may write starts and finishes, and records
the paths that differ as touched by that session. The changelist of a shared worktree shows only the session's own
files by default ("Show all" lifts the filter); a sub session's own files include those of its parent, so it sees
the parent's changelist plus its own and hides only sibling sub sessions. Unattributed changes count as the
top-level session's; files other sessions touched carry those sessions' marks. Committing, shelving or reverting a
file clears its attribution.

Every snapshot that differs from the previous one also goes into the worktree's edit log with the session that made
the difference. Log and snapshot objects live in Hunt's app data (`edit-log/<id>/`, objects written through
`GIT_OBJECT_DIRECTORY` with the repository's objects as alternates), never in the repository, and are deleted with
the last session of the worktree. For a file other sessions changed too, the diff offers "All changes" and "This
session": the latter replays the file's versions from the log (`src/diff/ownChanges.ts`) and shows, read-only, only
the lines the session and its parent changed.

#### Pull request reviews

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
in the review summary with the commented lines as a code block. "Comment on file" in the header of the diff views
drafts a comment on the whole file, shown above its first line; GitHub's REST API cannot take those with a review,
so the review is then created pending, gets them through GraphQL and is submitted there (`src-tauri/src/github.rs`).
The review threads already on GitHub show as cards under their lines as well, with the avatar of whoever opened them
before the lines and every reply below; resolved threads stay collapsed. They are loaded through GraphQL
(`list_review_threads`) into `src/state/reviewThreads.ts` when a file shows and they are older than 30 seconds, and
right after a review was submitted. A draft's card carries the avatar of the account `gh` is logged in as.
Every card ends in GitHub's "Write a reply". A reply is drafted like a comment ("Start a review" / "Add review
comment", stored with `replyTo`) and shows as "Pending" in its card until the review goes out: a reply to a draft
joins the thread that draft opens (or its note), a reply to a thread on GitHub is added to the pending review through
GraphQL. While nothing is drafted, "Add single comment" posts a reply to a GitHub thread right away. "Resolve
conversation" resolves a GitHub thread (or unresolves it) at once; a reply whose thread is gone keeps a card of its own.

#### Editor

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
| ⌘click | Go to declaration in the same pane (in the diff: in the editor window) |
| ⇧⌘click | Open the position in WebStorm |
| ⌘E / ⌘R | Move the active tab to the pane on the left / right, creating it when needed |
| ⇧⌘E / ⇧⌘R | Move the active tab to the pane above / below |
| ⌘W / ⇧⌘W | Close the active tab / every tab |
| ⇧⌘2 | Select the file in the project tree |
| ⌘S | Save |
| ⌘P or double shift | "Go to File": fuzzy search over `git ls-files`; `name:12` jumps to line 12 |

#### Guardrails

"Guardrails" in the chat header opens a window of its own over the repository's rules (`.claude/rules/*.md`,
`CLAUDE.md`), skills (`.claude/skills/<name>/SKILL.md`) and architectural decision records
(`docs/adr/NNNN-title.md`, or the existing ADR folder), one tab each (`src/guardrails/`). Instructions, rules and
skills are shown in a tree of the worktree's folders, since Claude Code also reads a `.claude/rules` or
`.claude/skills` below any folder once it works on a file there; the "+" of a folder creates an entry in that
folder's `.claude`. Entries open in a Markdown editor. "New …" and "+" open the page of a new file with the kind's
template (ADRs are numbered after the highest existing one) and its agent chat; the file is written only once the
template was edited or the agent wrote it, so no template file and no empty folder is ever left behind. ⌘S or
"Save" writes an open file.

Opening a session checks that the worktree's root `CLAUDE.md` names the ADR folder and otherwise offers once to
append an "Architectural decisions" section with the `ls`/`grep` lookup (`src/guardrails/adrInstruction.ts`);
without it Claude Code never reads the records. A decline is remembered until the app restarts.

#### Dependency graph

The Dependency Graph tab asks the agent (hidden turn, standard prompt in `src-tauri/src/graph.rs`) to write
`.hunt/graph.json` (git-excluded, schema in `src-tauri/src/graph.schema.json`): one node per changed file plus the
unchanged files that explain the change, and one edge per dependency with a label stating how the source uses the
target (one to three words, a verb, a noun or both, in the AI language from the settings) and a description of how
it is used. The refresh prompt names the session's diff base: `HEAD`, or the merge base of a reviewed pull request.
For the refresh turn the session's agent switches to the model and effort from Settings → Agent (default
`claude-opus-5-5` with `high`) and back to the chat's choice afterwards.
`src/graph/` validates it, fills pairs the agent left out with unlabeled edges read from the import statements and
lays it out with ELK inside React Flow.

The modification time of `graph.json` is the time the diagram was generated; every session records in
`sessions.json` when it last changed worktree files (agent edits via the change attribution, saves in Hunt panes,
revert, shelve, unshelve), and the panel marks the diagram "Outdated" once such a change is newer than the diagram
(`graph_status` command).

#### Remote sessions

A session can move to a Compute Engine VM and keep working there while Hunt is closed ("Remote" in the chat header,
set up under *Settings → Remote VM*). `src-tauri/src/remote/` reaches the VM over SSH through an IAP tunnel with the
gcloud login and a key Hunt registers with OS Login, starts the VM when it is off, and installs the VM side from this
repository's `remote/` folder, which ships with the app, whenever the VM runs another version of it.

A handoff (`hand_off_session`) stops the local agent and pushes the branch plus a snapshot commit of the uncommitted
work (`refs/hunt/<id>/handoff`) into the session's own repository on the VM, `/srv/worktrees/<id>`; the VM needs no
access to GitHub. The Git LFS objects of the checkout, the ignored files matching the settings' patterns (default
`**/.env.private`) and the Claude Code transcript follow, the transcript with its paths moved to the VM.
`remote/vm/hunt-ctl` checks the branch out there, installs the dependencies and starts one container per session from
`remote/image/` with the OAuth token of the selected Claude account, which Hunt passes on stdin; the local login stays
on the Mac, so a remote session needs a token account. The container's entrypoint is the relay (`remote/relay/`): it
owns the ACP adapter, loads the conversation once and serves it over a Unix socket. Hunt's agent process for the
session is then `ssh … socat` to that socket, so the chat works as before; a client that connects later gets the
conversation replayed, and the relay reports a running turn. Diff, editor, graph and guardrails stay local and wait
until the session comes back.

Sessions on the VM are kept apart: every git, tar or file operation `hunt-ctl` runs on a session's files happens in a
throwaway container without network that sees only that session, so its hooks, Git config and symlinks never act on the
host; each session's containers get their own Docker network, and `hunt-firewall.service` keeps them off the VM's own
services and the metadata server. Files that come back from the VM are copied without following symlinks.

The relay also supervises the session's preview (`remote/relay/preview/`), which the `preview` section of the
repository's `hunt.json` describes: services from Hunt's catalog, environment, `prepare` and `init` steps and processes
with ports. `contract.ts` checks that section and builds a plan from it (`planCli.ts`, which `hunt-ctl` runs in a
sandbox). `supervisor.ts` runs a plan it receives on `preview.sock` (`control.ts`): it forwards `127.0.0.1:5432` and
`:6379` to the service containers, runs the `prepare` steps, the `init` steps once per data generation and then every
process in a process group of its own, with readiness checks and restarts with backoff. A process with a port has to
listen on 0.0.0.0: the readiness check, like the edge proxy, connects to the container's address. `preview.json`, the
applied plan and one log per process lie in the socket folder's `preview/`; a relay restart within the same boot
resumes the plan. The agent checks and restarts the processes and reads their logs with `hunt-preview` (`cli.ts`).

*Open preview* (cloud menu, or the preview panel to the right of a remote session's chat) runs `hunt-ctl preview
start` with the preview domain from *Settings → Remote VM*. It reads `hunt.json` inside the session's container, starts
the services as containers on the session's network, raises the container's memory limit and hands the plan to the
relay. The edge proxy `hunt-edge` (Caddy on port 8080 of the VM) serves `https://<short id>.<domain>` and
`https://<short id>-<port>.<domain>` to the load balancer, which lets only IAP's access group through, and removes
IAP's headers and cookies before a request reaches a dev server; `<short id>` is the first 8 hex digits of the session
ID. `src/preview/PreviewPanel.tsx` shows the state, the links and one log per process. Page views and requests other
than GET keep the VM awake, for at most two hours without a turn.

Bringing it back (`retrieve_session`) stops the container, snapshots the VM's worktree on top of the agent's commits
(`refs/hunt/<id>/retrieve`), fetches it and applies it to the local worktree, which must still hold the handoff
snapshot; the branch moves to the agent's last commit and the transcript returns. The VM shuts itself down after 30
minutes without a running turn, client activity or terminal login (`remote/vm/hunt-idle-check`); the next prompt
starts it again.

&nbsp;

### 📁 Project layout

| Path | Owns |
| --- | --- |
| `src-tauri/src/acp/` | Agent process per session, ACP event forwarding |
| `src-tauri/src/git.rs` | Worktrees, changelists, shelve and revert |
| `src-tauri/src/github.rs` | Pull requests through `gh` |
| `src-tauri/src/session/` | Session commands, store, attribution, summaries, reviews |
| `src-tauri/src/lsp.rs` | One `tsgo --lsp` process per worktree |
| `src-tauri/src/workspace.rs` | Project tree and file access |
| `src-tauri/src/graph.rs` | Dependency graph prompt and status |
| `src-tauri/src/remote/` | SSH to the VM, handoff and retrieval of remote sessions, previews |
| `remote/` | VM side of remote sessions: relay with the preview supervisor, container image, `hunt-ctl` |
| `src/ipc/` | Every Tauri command, event and shared type |
| `src/state/` | Zustand stores and chat reducers |
| `src/chat/`, `src/diff/`, `src/ide/`, `src/graph/`, `src/guardrails/`, `src/preview/`, `src/review/`, `src/sessions/`, `src/settings/` | One folder per tab or window |
| `src/ui/` | Primitives shared by every feature |
| `docs/adr/` | Architectural decision records |

&nbsp;

### 🧠 Architectural decisions

Decisions that shape the codebase are recorded in [`docs/adr/`](docs/adr), one file per decision with Context,
Decision and Consequences. Read them before changing the parts they cover.

&nbsp;

### 📜 License

Hunt is released under the [MIT License](LICENSE).

The file icons in `src/diff/atomIcons/` are the [Atom Material Icons](https://github.com/mallowigi/iconGenerator) in
pastel colors (MIT, see the `LICENSE` file in that folder). Release bundles ship the Claude Agent SDK and the ACP adapter from npm
under their own terms: `@anthropic-ai/claude-agent-sdk` is © Anthropic PBC and governed by the
[Claude Code legal agreements](https://code.claude.com/docs/en/legal-and-compliance); `@agentclientprotocol/*` is
Apache-2.0; `zod` is MIT; `diff` is BSD-3-Clause. Using Hunt requires a Claude account whose terms apply to the agent.

&nbsp;

<p align="center">
  <img src="docs/assets/footer.svg" alt=""/>
</p>

<p align="center">
  Copyright &copy; 2026-present Yannick Boetzkes
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-b7bdf8?style=for-the-badge&labelColor=363a4f"></a>
</p>
