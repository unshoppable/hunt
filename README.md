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
`session/update` to the UI as the `acp:update` event; permission requests become `acp:permission`, and one the agent
withdraws with `$/cancel_request` becomes `acp:permission-withdrawn`, which removes it from the chat.

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

A session can move to a Compute Engine VM of its own and keep working there while Hunt is closed ("Remote" in the chat
header, set up under *Settings → Remote VM*: project, zone, gateway, session VM template, machine type and preview
domain). The handoff creates the VM `vm-hunt-s-<short id>` (`<short id>` is the first 8 hex digits of the session ID)
from the instance template `tpl-hunt-session`, labels it `hunt-role=session`, `hunt-session=<short id>` and
`hunt-origin=desktop`, and records the session's ID, repository, branch and title in its metadata
(`src-tauri/src/remote/vm.rs`). `src-tauri/src/remote/` reaches the VMs over SSH through an IAP tunnel with the gcloud
login and a key Hunt registers with OS Login, starts a session's VM when it is off, waits on a new VM until its startup
script wrote `/var/lib/hunt/session-ready`, and installs the VM side from this repository's `remote/` folder, which
ships with the app, on the session's VM and on the gateway (`hunt-ctl install <dir> --domain <domain>`) unless their
last complete install, which `hunt-ctl` records as its last step in `/var/lib/hunt/installed-hash`, was of this version
(and, on the gateway, of this preview domain). The session's VM gets it at the handoff and again whenever Hunt connects
to the session or brings it back; a relay that runs keeps running and starts on the new release with its next start.

A handoff (`hand_off_session`) stops the local agent and pushes the branch plus a snapshot commit of the uncommitted
work (`refs/hunt/<id>/handoff`) into the session's repository on its VM, `/home/agent/<repository name>`, so the handoff
needs no access to GitHub. The Git LFS objects of the checkout, the ignored files matching the settings' patterns
(default `**/.env.private`) and the Claude Code transcript follow, the transcript with its paths moved to the VM. The
agent's `~/.claude` there (`/home/agent/.claude`) also gets the user's `CLAUDE.md`, `rules/`, `skills/`, `agents/`,
`commands/` and `output-styles/`, and the memory of the repository (`projects/<slug of the main checkout>/memory/`);
`settings.json` and plugins stay on the Mac. `remote/vm/hunt-ctl` checks the branch out there; `hunt-ctl
session-config` writes the session's environment and preview proxy from the repository's `hunt.json` and returns its
`HUNT.md`, which Hunt appends to the agent's system prompt. Then `hunt-ctl` installs the dependencies and starts the
relay with the OAuth token of the selected Claude account, which Hunt passes on stdin; the local login stays on the
Mac, so a remote session needs a token account. A failed handoff removes the session's worktree from the VM but keeps
the VM (`leftoverVm` in `sessions.json`): the next attempt skips the first boot, and deleting the session deletes it.

With a GitHub token under *Settings → Remote VM* (`src-tauri/src/github_token.rs`, kept in the keychain), the agent pushes
and runs `gh` as the user: the token goes on stdin next to the Claude token into the relay's `GH_TOKEN`, the
repository there gets `origin` as `https://github.com/<owner>/<repo>.git` with the branch's upstream, and git and Git
LFS authenticate through gh's credential helper. A repository's `core.hooksPath` inside the worktree (husky's
`.husky`) comes along with its ignored files, so commits and pushes on the VM run the same hooks; without one, Git LFS's
hooks upload LFS files on push. Everyone with root on the VM can read the token, so it should be a fine-grained token
limited to the repositories handed off.

The relay (`remote/relay/`) runs on the VM as the systemd service `hunt-relay` of the user `agent`: it owns the ACP
adapter, loads the conversation once and serves it over `/run/hunt/relay.sock`. Hunt's agent process for the session is
then `ssh … sudo -n -u agent socat - UNIX-CONNECT:/run/hunt/relay.sock`, so the chat works as before; a client that connects later gets the
conversation replayed, and the relay reports a running turn. Several clients, such as the Hunt apps of different
people, can be attached at once: each gets every update live, their prompts run one after another, and a permission
request goes to all of them; the first answer counts, and the relay withdraws the request from the others. Diff,
editor, graph and guardrails stay local and wait until the session comes back.

Every session has a VM of its own, which is the isolation boundary: the agent works there as the user `agent`, with
Docker and Docker Compose, and starts the app as a developer would locally. `remote/vm/hunt-ctl` runs every git, tar
or file operation in the session's files as `agent`, so the agent's hooks, Git config and symlinks act with no more
rights than the agent has anyway. Files that come back from the VM are copied without following symlinks.

`/etc/hunt/role` tells `hunt-ctl` whether it runs on a session VM or on the gateway. On a session VM, `hunt-ctl
install` puts the release under `/srv/hunt/releases/<hash>` and adds what the agent works with besides the VM's base
image: build tools, gh, Terraform, Volta for the Node and npm versions a repository pins, the ACP adapter in the version
`remote/session/acp-version` pins, with the native Claude Code CLI, and Playwright's MCP server with Chromium
(`remote/session/playwright/`, offered to Claude Code through `remote/session/mcp-servers.json`); a tool that is at its
version already is skipped. The relay runs as `hunt-relay.service` (`remote/vm/systemd/session/`) with the agent's
environment (`remote/vm/agent.env`), the session's variables and the tokens of `/etc/hunt/secrets.env`, which only root
reads. A restart of the relay, such as `/clear`, leaves the dev servers and the tmux session the agent started running.
Login shells of `agent`, such as the terminal's tmux session, get the same environment without the tokens
(`/etc/profile.d/hunt.sh`).

`hunt-ctl session-config` reads the `preview` section of the repository's `hunt.json` (contract version 2,
`remote/session/config.ts`): `env` with the placeholders `${HUNT_PREVIEW_URL}` and `${HUNT_PREVIEW_URL_<port>}`,
`main`, `routes` (path prefix → port on every preview host) and `tls` (ports that speak HTTPS). It writes the session's
environment, `/etc/hunt/session.env`, and the configuration of the VM's preview proxy, `hunt-proxy.service` (Caddy on
port 8080), which serves `<short id>.<domain>` from the main port and `<short id>-<port>.<domain>` from that port on
localhost (servers bound to 127.0.0.1 or ::1), keeps the Host header and logs every request to
`/var/log/hunt-proxy/access.log`. `hunt-ctl preview-status` reports the main port, the ports that listen on all or the
loopback addresses and whether the main port answers on localhost.

The gateway, a VM that runs all the time, routes `https://<short id>.<domain>` to the session VM's main port, which the
repository's `hunt.json` names, and `https://<short id>-<port>.<domain>` to any of its ports; the load balancer in
front of it lets only IAP's access group through, and a request for a VM that is off starts it. The agent starts the
app itself, as a developer would locally. The *Preview* tab next to a remote session's chat
(`src/preview/PreviewPanel.tsx`) polls `preview_status`, which runs `hunt-ctl preview-status <id>` on the VM, and shows
the main URL, every port that listens with its URL and whether the main port answers; Hunt builds the URLs from the
session ID and the preview domain of the handoff, the VM reports only port numbers. When the main port does not
answer, *Start the app* (or *Open preview* in the cloud menu) sends the agent "Start the app for the preview as
described in the repository (HUNT.md, README)." as a normal prompt, which starts a VM that is off, and opens the main
URL once it answers.

The gateway keeps no sessions. Its edge proxy `hunt-edge` (Caddy in Docker on port 8080 behind the load balancer)
serves only the load balancer's address ranges, removes IAP's headers and cookies and forwards every preview host with
its Host header to `vm-hunt-s-<short id>.<zone>.c.<project>.internal:8080`: the session VMs' internal DNS names are the
whole routing table. A request it cannot deliver (502, 503 or 504, because the VM is off or still booting) goes to
`hunt-wake.service` on 127.0.0.1:9180 (`remote/gateway/wake.ts`). It looks the VM up through the Compute Engine API
with the gateway's service account, starts or resumes it for a page load, at most once every 30 seconds and never for
a script's request of a tab already open, and answers with a page that reloads every 5 seconds until the VM answers.
`hunt-firewall.service` keeps containers on the gateway off the metadata server, whose token can start VMs.

Next to the preview, the *Terminal* tab (`src/terminal/TerminalPanel.tsx`, xterm.js) attaches to the tmux session
`app` on the VM, in which the agent runs the app's long-running processes, one window per process. The backend
(`src-tauri/src/remote/terminal.rs`) runs `ssh -tt … sudo -n -iu agent tmux -u new-session -A -s app` in a local
pseudo terminal (`portable-pty`), so the programs see a real TTY and keep their colors; several people can attach at
once. The terminal joins the shared SSH connection when one is open but never starts it, and streams its output to the
window that opened it as base64 chunks (`terminal:output`, then `terminal:exit`). It connects when the tab is first
shown, stays connected while the preview tab shows, and ends with the session's panel, its window or a reload; tmux
keeps the processes running. A VM that is off is not started for it.

The *Diff* tab of a remote session (`src/diff/RemoteDiffPanel.tsx`) shows its changes on the VM read-only: committed
and uncommitted, against the merge base of the VM's `HEAD` with the handoff head (for a session the poller started,
with the origin's default branch). `src-tauri/src/remote/diff.rs` runs one bash script per request as `agent` in the
worktree on the VM and returns the shapes of the local changelist (`ChangedFile`, `FileDiff`). The list reloads after
every turn that ends on the relay, whoever sent it, and on *Refresh*; a VM that is off starts only on request. Revert,
shelve and review comments stay switched off until the session is brought back.

Bringing it back (`retrieve_session`) stops the relay, snapshots the VM's worktree on top of the agent's commits
(`refs/hunt/<id>/retrieve`), fetches it and applies it to the local worktree, which must still hold the handoff
snapshot; the branch moves to the agent's last commit and the transcript returns. Then Hunt deletes the VM with its
disks (`gcloud compute instances delete --delete-disks=all`), as it does when a remote session is deleted. A deletion
that fails, for example offline, is kept in `remote-cleanups.json` in the app data folder and retried with gcloud alone
at the next start of Hunt. Hunt deletes no VM whose name is not the session's `vm-hunt-s-<short id>`. What the agent changed in the
memory is merged into the local one three-way against what the handoff sent (`src-tauri/src/remote/memory.rs`): a file
only the VM changed takes its version, one both sides changed keeps the local version with the VM's next to it as
`<name>.remote-<id>.md`, and `MEMORY.md` takes the VM's added and removed lines.

Sessions an older Hunt handed off to the VM all sessions shared, today's gateway, keep running there in containers
under the `hunt-ctl` of that time until they come back (`src-tauri/src/remote/legacy.rs`); their record names that VM
instead of `vm-hunt-s-<short id>`. Hunt connects to them through `/srv/hunt/sockets/<id>/acp.sock` without installing
anything, brings them back with the same `hunt-ctl` commands and then runs `hunt-ctl destroy <id>` on the gateway
instead of deleting a VM. While such a session exists, Hunt refuses every handoff, since it would install the current
release on the gateway and strand them.

The gateway's poller `hunt-swf.service` (`remote/gateway/swf.ts`) starts a session for every open GitHub issue labelled
`swf` in the repositories listed under *Settings → Remote VM → GitHub issues (swf)*; *Apply to gateway* installs this
app's bundle on the gateway and writes them with the session limit to `/etc/hunt/swf.json` (`hunt-ctl swf-config`).
Every 2 minutes it lists the open issues through GitHub's REST API and, while fewer of its VMs (label
`hunt-origin=swf`, any status but `TERMINATED` and `STOPPED`) are up than the limit allows, claims the oldest issue:
`swf` becomes `swf:running` (the labels `swf:running`, `swf:done` and `swf:failed` are created when missing) and a
comment names the session's preview URL. Then it does what a handoff does, with the gateway's service account instead
of a Mac: it creates `vm-hunt-s-<short id>` from the instance template through the Compute Engine API, records the
session, repository, branch `hunt/<issue>-<slug of the title>`, title and issue in the VM's metadata, waits for the
startup script and installs the gateway's own release on the VM over `gcloud compute ssh --internal-ip` (OS Login as
admin). `hunt-ctl clone` clones the repository from GitHub as `agent` onto the branch (the origin's branch of that name
when it exists, else a new one from the default branch) with the token's GitHub user as Git identity; `session-config`,
`put-files --claude` with `hunt-session.json`, `deps`, `start` and `wait` follow as in a handoff. The system prompt is
the remote part a handoff appends (`remote/session/prompts/`, which the app compiles in) and the repository's HUNT.md;
the parts Hunt takes from its user's settings (response style, guardrail offer, diagram language) do not exist on the
gateway. The poller then sends the issue with all its comments as the first prompt through the relay and disconnects;
the relay runs the turn without a client. The prompt asks the agent to implement and check the issue, push the branch,
open a pull request with `Closes #<issue>`, comment its link on the issue and replace `swf:running` with `swf:done`, or
with `swf:failed` and a comment when it cannot finish. A setup that fails gets `swf:failed` and a comment with the
error; its VM stays for inspection. The poller's GitHub token and the Claude Code OAuth token its sessions run with come
from Secret Manager (`HUNT_SWF_GITHUB_TOKEN`, `HUNT_SWF_CLAUDE_TOKEN`) and never reach a log line, a comment or a
command line; `journalctl -u hunt-swf` on the gateway shows one line per decision.

The labels and metadata of the session VMs are the directory of remote sessions. At its start and from the sidebar's
*Refresh remote sessions* button, Hunt lists those in the zone of the settings, the zone whose VMs the gateway routes
previews to (`adopt_session_vms`, `src-tauri/src/remote/adoption.rs`), and adopts every VM whose `hunt-session-id` no
local session has: VMs the gateway's poller started for `swf` issues
(`hunt-origin=swf`, `hunt-issue`) and other people's handoffs. An adopted session gets a record with origin `swf` or
`desktop`, its title, branch and repository from the metadata and the local checkout among the recently used
repositories whose `origin` is that repository; the sidebar labels it `swf #<issue>` or `remote`. Its worktree path on
the VM comes from `/srv/hunt/sessions/<id>/meta.json` once Hunt reaches the VM, and the relay replays its conversation
on `session/load`. Bringing it back creates a new worktree in the local checkout on the branch the VM has checked out
and is offered only once a checkout is known. Deleting or bringing back an adopted session asks first, naming its VM,
since other people may work on it; VMs this Mac deleted or still has to delete are never adopted again.

A remote session keeps its VM, which costs only its disk while it is off, until it is retrieved or deleted. Hunt records when its agent last worked (a
prompt it sent, a turn that ended, or the relay's last turn when it connects) and, once that is seven days ago, asks in
the main window whether to retrieve or delete it (`src/sessions/StaleRemoteDialog.tsx`); "Later" asks again three days
later. A session VM shuts itself down after 30 minutes without a running turn, client activity, terminal input or
`hunt-ctl` run (`remote/vm/hunt-idle-check`, every minute through `hunt-idle.timer`); a preview page view or a request
other than GET counts too, for at most two hours after the agent last worked. Dev servers and containers the agent left
running do not count. The disk keeps everything: the next prompt or preview page starts the VM again, and the agent
restarts the app's containers and dev servers.

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
| `src-tauri/src/remote/` | Session VMs, SSH to them, handoff and retrieval of remote sessions, previews, terminals |
| `remote/` | VM side of remote sessions: `hunt-ctl`, the relay, the session VM's configuration, the gateway's wake service and issue poller |
| `src/ipc/` | Every Tauri command, event and shared type |
| `src/state/` | Zustand stores and chat reducers |
| `src/chat/`, `src/diff/`, `src/ide/`, `src/graph/`, `src/guardrails/`, `src/preview/`, `src/review/`, `src/sessions/`, `src/settings/`, `src/terminal/` | One folder per tab or window |
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
