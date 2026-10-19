<h3 align="center">
  <img src="apps/client/src-tauri/icons/icon.png" width="100" alt="Hunt logo"/><br/>
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

- **Isolated sessions.** Each session gets a `feat/general/<slug>-<id>` worktree; shelve, revert and commit per file.
  *Push* lands the commits on the branch the session was created from; the worktree's branch never reaches `origin`.
- **Sub sessions.** Start a background agent in an existing worktree, or ask Claude about a selected diff range.
- **Change attribution.** Sessions sharing a worktree see only their own files; shared files carry a badge.
- **Built-in IDE.** Project tree, Monaco panes with tabs, breadcrumbs, go-to-declaration, usages, inlay hints and
  diagnostics from the TypeScript 7 language server, WebStorm-style semantic coloring and folder colors.
- **Pull request reviews.** Pick an open PR, review its diff against the merge base, draft inline comments in the
  gutter and submit the review through `gh`.
- **Architecture diagrams.** The agent writes a dependency graph of the change to `.hunt/graph.json` and C4, state,
  ERD and process diagrams to `.hunt/diagram.<type>.json`; Hunt validates them and lays them out with ELK inside
  React Flow in its own style. A diagram flags itself as outdated when the worktree changes.
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
- Node 24 and npm 11 (the root `package.json` pins the exact versions for [Volta](https://volta.sh)) and a Rust
  toolchain (`rustup`)
- A Claude Code login (`claude /login`); the agent runs under your subscription
- Optional: the `gh` CLI, logged in, for pull request reviews
- Optional: WebStorm via JetBrains Toolbox, for "Open in WebStorm"

#### Run

```sh
npm install
npm run start:client
```

`npm run start:client` runs `nx run client:dev`: `tauri dev` in `apps/client`, which starts Vite first.
`npm run tauri -- <args>` runs any other Tauri CLI command there.

#### Verify

```sh
npm run check                                      # typecheck, lint, vitest and cargo test of every project
npx nx affected -t typecheck lint test test-rust   # the same for the projects a change touches
npx nx run session:test                            # one target of one project
```

#### Release

```sh
npm run tauri -- build --bundles dmg   # local DMG in apps/client/src-tauri/target/release/bundle/dmg/
```

Every push to `master` runs [`ci-release.yml`](.github/workflows/ci-release.yml), as in app-framework. `nx release`
derives the next version of each app from the Conventional Commits that touch it (`feat` → minor, `fix`/`perf` →
patch, `!` or `BREAKING CHANGE` → major), independently per app: it writes the version into the app's `package.json`
(`apps/client/src-tauri/tauri.conf.json` reads `apps/client/package.json`) and a `CHANGELOG.md`, commits
`chore(release): …` and tags `<app>@<version>`. A release commit then

- deploys the VM apps (`gateway`, `session`) affected since the commit the VMs run, the tag `deployed/prod`
  ([`ci-nx-affected-deploy.yml`](.github/workflows/ci-nx-affected-deploy.yml),
  [`ci-build-and-deploy.yml`](.github/workflows/ci-build-and-deploy.yml)), and moves the tag;
- publishes the session release when it got a `session@<version>` tag
  ([`ci-publish-session.yml`](.github/workflows/ci-publish-session.yml), also `workflow_dispatch`): the built release
  (`dist/apps/session`) as the asset `session.tar.gz` on the GitHub Release `session@<version>`, never marked latest;
- builds the image new session VMs boot from, family `img-hunt-session`, out of the newest of these releases
  ([`ci-session-image.yml`](.github/workflows/ci-session-image.yml), also `workflow_dispatch`): as `sa-image-hunt`
  (Workload Identity Federation, master only) it creates a build VM from the session VM template in the first session
  zone with capacity; the VM's base setup, which the infrastructure repository keeps in the project metadata,
  downloads the asset, runs its `hunt-ctl install-tools`, cleans the disk and powers the VM off, and the job takes the
  image from its disk. Nobody logs in to that VM. Session VMs still run `install-tools` on every connect, which skips
  tools at their version;
- publishes the desktop app when it got a `client@<version>` tag
  ([`ci-publish-client.yml`](.github/workflows/ci-publish-client.yml)): the Apple Silicon DMG plus the updater
  artifacts (`Hunt.app.tar.gz`, its `.sig` and `latest.json`) on the GitHub Release `client@<version>`, published as
  the latest once the build is green. Publishing is what makes running installs offer the update: the in-app updater
  reads `latest.json` of the latest *published* release. The gateway release gets no GitHub Release.

`npx nx release --skip-publish --dry-run` shows what the next run would do. Pull requests run
[`ci-pull-request.yml`](.github/workflows/ci-pull-request.yml): `nx affected` typecheck, lint, test and build, and the
Rust tests on macOS.

The updater artifacts are signed with the key whose public half is in `apps/client/src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`); the workflow reads the private key from the repository secrets `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Moving `deployed/prod` and creating and publishing the GitHub Release take
the token of the release GitHub App, from the secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` (permissions
Contents and Workflows, read and write, installed on this repository), as in app-framework: `GITHUB_TOKEN` may not move a
ref across commits that change workflow files. A local build only produces them with the same two variables set and
`apps/client/src-tauri/tauri.release.conf.json` as an extra config
(`npm run tauri -- build --config src-tauri/tauri.release.conf.json`, relative to `apps/client`). Losing the key means
shipping a new key with a DMG that users install by hand.

See [CLAUDE.md](CLAUDE.md) for the conventions contributors and coding agents follow in this repository.

&nbsp;

### 🧩 How it works

#### Sessions and the agent

`apps/client/src-tauri/src/acp/` spawns `@agentclientprotocol/claude-agent-acp` per session and forwards every
`session/update` to the UI as the `acp:update` event; permission requests become `acp:permission`, and one the agent
withdraws with `$/cancel_request` becomes `acp:permission-withdrawn`, which removes it from the chat.

A session starts in the start view of the chat pane ("New" in the sidebar), which preselects the repository used
last. Choosing a repository there, from the folder dialog or the list of recently used ones, creates the session right
away, so the sidebar lists it and the diff, editor and graph panes work before anything was asked; such a session is
titled after its repository until its first prompt names it (`rename_session`). With the preselected repository the
first prompt creates the session and titles it. The view's header has "PR review" and "Remote sessions": each replaces
the view's body with a list in the chat pane (no popover), of the repository's open pull requests or of the session
VMs the gateway lists; choosing a pull request starts a review session on its branch, choosing a remote session shows
it, adopting it first when this Mac does not know it (`apps/client/src/sessions/PullRequestList.tsx`,
`SessionVmList.tsx`, `list_session_vms`). The bar under the composer picks the workspace (a worktree or the
repository's checkout) and the base branch; its branch menu's "New branch…" names a branch the session creates instead
of the generated one (`newBranch` of `create_session`, checked by `sessions/newBranch.ts` and `git::ensure_new_branch`):
off the base in a worktree, or at the checkout's own branch, which the checkout switches to. Such a branch is the
session's base like a reviewed pull request's: a push lands on it under its own name and deleting the session keeps it.

The sidebar groups the sessions by repository, each group under a heading with the repository's name
(`groupSessions` in `apps/client/src/sessions/sessionLabels.ts`): groups in alphabetical order, inside a group the
sessions in creation order, each followed by its sub sessions. A session's row shows its title, its branch and the
branch on origin a push lands on, with the pull request or issue it works on as a badge.

The mark of a session in the sidebar (`apps/client/src/sessions/SessionMark.tsx`) shows what its agent is up to: an arc
runs around it while a turn runs; it turns amber with a `?` badge when the agent ended its turn with a question
(`hasPendingQuestion` in `src/state/store.ts`: the chat is idle and its last item is an agent message that asks one,
so the state ends by itself once the user's answer follows and holds for a remote session's replayed conversation
too); it turns green when a turn finished while another session was active and the user has not opened the session
since. The agent marks a question explicitly by ending its reply with `<!-- hunt:question -->` (`hasQuestionMarker`
in `src/chat/questionMarker.ts`); `libs/domain/prompts/question.system-prompt.md` tells it so and is part of every
session's system prompt, local and remote. A last paragraph ending with a question mark remains the fallback
(`endsWithQuestion`). The marker is hidden in the chat like the guardrail marker and dropped from the transcript the
guardrail agent gets. The chat pane shows the state as well: a "Question" chip in its header and a note under the
messages (`ChatPanel.tsx`). A remote session whose conversation was never loaded takes the agent state the gateway
recorded for its VM (`remote.agent`, see "Remote sessions").

A sub session is a fresh agent session in the worktree of an existing session. "sub session" on a session in the
sidebar starts one with a title; selecting text on the right side of a diff and choosing "Ask Claude about
selection" in the context menu starts one as a sub chat with the selected lines in its system prompt. Sub sessions
run in the background, are listed under their parent in the sidebar and are removed together with it; those of a remote
session run on this Mac as well, in the session's local worktree (see *Remote sessions*). Every code
view of the worktree marks the first line of such a selection with a button right of the line number that reopens the
sub chat in its popover; the sub session's chat pane offers "Open in editor" for the selected lines.

The "Agent" page of the settings dialog holds what Hunt tells the agent on its own: the language of every output
Hunt asks for itself (session summaries and titles in `apps/client/src-tauri/src/session/summary.rs`, the dependency
graph), German by default, and the system prompt addition of every new session, by default the response-style
instructions in `apps/client/prompts/response-style.system-prompt.md` (plain language for software engineers). The frontend pushes
both to `apps/client/src-tauri/src/preferences.rs` at start and on change; `apps/client/src-tauri/src/acp/connection.rs`
appends the prompt, the diagram instructions and the selection context of a sub session to Claude Code's system prompt
via the ACP `systemPrompt` meta.

#### Worktrees and changes

`apps/client/src-tauri/src/git.rs` creates `feat/general/<slug>-<id>` worktrees under the app data directory (the
`<type>/<scope>/<name>` form repositories check branch names against; a pull request review works on the pull
request's own branch, a session the user named a branch for on that one), lists their changes against the session's diff base (`HEAD`, or the merge base of a reviewed
pull request) and supports shelving and reverting them. The worktree's branch is local only: the changelist's *Push*
(`push_branch`) pushes `HEAD` to the branch the session was created from on `origin` (`push_target` in
`session/commands.rs`: the base branch, a reviewed pull request's branch, the checkout's own), after a rebase onto it
when it moved on; a conflict aborts the rebase and names the files. A first prompt that starts with the URL of a GitHub
issue or pull request titles the session `#<number> <title>` (`issueFromPrompt`, `issue_title` via `gh`).

A new worktree has none of the repository's ignored files either, which is where a service's `.env.private` lives. Each
service of the repository's `hunt.json` names the ones it needs as glob patterns under `worktreeInclude`
(`"worktreeInclude": ["apps/med/.env.private"]`; the contract below), and `apps/client/src-tauri/src/private_files.rs`
copies the matching ignored files of the repository's own checkout into every worktree Hunt creates, for a new session,
an adopted remote session and a retrieved one, files inside ignored folders included and `node_modules` left out; a file
the worktree has already stays. Claude Code and Conductor read the same kind of list from `.worktreeinclude`.

A new worktree has no `node_modules`, so `apps/client/src-tauri/src/session/dependencies.rs` prepares it in the
background: when the repository has an installed `node_modules`, it is cloned with one APFS `clonefile` call
(copy-on-write, seconds instead of minutes, no extra disk space); when the worktree's lockfile differs from the
repository's, or there is nothing to clone, the package manager the lockfile belongs to (npm, pnpm, yarn or bun)
installs on top. The editor shows the progress above its panes and the language server restarts once the modules exist.

Sessions sharing a worktree tell their changes apart by file: `apps/client/src-tauri/src/session/attribution.rs`
snapshots the worktree (`git write-tree` through a scratch index) when a tool call that may write starts and finishes,
and records the paths that differ as touched by that session. The changelist of a shared worktree shows only the
session's own files by default ("Show all" lifts the filter); a sub session's own files include those of its parent, so
it sees the parent's changelist plus its own and hides only sibling sub sessions. Unattributed changes count as the
top-level session's; files other sessions touched carry those sessions' marks. Committing, shelving or reverting a file
clears its attribution.

Every snapshot that differs from the previous one also goes into the worktree's edit log with the session that made
the difference. Log and snapshot objects live in Hunt's app data (`edit-log/<id>/`, objects written through
`GIT_OBJECT_DIRECTORY` with the repository's objects as alternates), never in the repository, and are deleted with
the last session of the worktree. For a file other sessions changed too, the diff offers "All changes" and "This
session": the latter replays the file's versions from the log (`apps/client/src/diff/ownChanges.ts`) and shows,
read-only, only the lines the session and its parent changed.

#### Git log

The Git tab after Diff is the worktree's history, laid out like IntelliJ's log: the branch tree on the left (Local,
Remote and Tags, nested by the slashes in their names; a click shows one ref's history, a second click every ref
again), the commits in the middle with the graph, the branch and tag chips, author and date, and on the right the
files of the selected commit as a folder tree, its message, author, committer, refs and containing branches, and the
read-only diff of the selected file against the commit's first parent. The log pages through `git log --date-order`
500 commits at a time (`git_log`, `apps/client/src-tauri/src/git.rs`), the text field matches the message or names a
commit by its hash, and commits no remote has yet carry an arrow. `apps/client/src/git/commitGraph.ts` lays the
lanes out from the parent lists, `CommitLog.tsx` renders only the visible rows, and the log reloads after every turn
of the agent and every local write. The log opens on the session's branch, which the tree marks with the branch its
push lands on (`→ master`). A right click on a branch opens its menu (`src/git/branchActions.ts`): rebase the
checked-out branch onto it or merge it in (a conflict aborts and names the files), update it (the session's branch is
rebased onto the branch its push lands on, as the push does first; another local branch is fast-forwarded from its
upstream), push, rename and delete it (a branch with commits no other branch has only after a confirmation), and for
a remote branch fetch it or delete it on `origin`. A rebase, merge or update of a remote session's branch moves the
branch on its VM to the new commit, as the rebase before a push does. The push target is the upstream of the session's
branch (`branch.<name>.merge`, set to the base branch when the session is created and changed with "Change push
target…", which also creates a branch `origin` lacks at the commit of the branch pushed to so far), so it travels
with the branch: the handoff copies it to the VM (`hunt-ctl prepare --upstream`), a change is written on both sides,
and every connect takes over what the VM records (`sync::take_over_vm_push_target`), so a Hunt that continues a
session another one handed off pushes where that one meant to; the session record mirrors it as `baseRef`.

#### Pull request reviews

`apps/client/src-tauri/src/github.rs` lists the open pull requests of a repository and reads one with its conversation
through the `gh` CLI. The "PR review" button of the new-session view (`apps/client/src/sessions/PullRequestList.tsx`)
lists them in the chat pane with a search box; picking one starts the session right away, without a prompt: a worktree on the pull
request's own branch, titled after the pull request, with the pull request and the merge base with its target branch
stored in the session (`pullRequest` and `diffBase` in `sessions.json`). The worktree checks the local branch of that
name out, or creates it to track the branch on its remote; it fails when another worktree, the repository's checkout
included, has the branch checked out already. Deleting the session deletes the branch only when Hunt created it
(`keepsBranch` in `sessions.json` is set otherwise).

The changelist of such a session compares against that merge base, so it lists the pull request's changes, and its
"Submit review…" button posts a comment, approval or change request through `gh pr review`. The "PR Description" tab
(`apps/client/src/review/`) renders the pull request's description, comments and reviews like GitHub's conversation
view. In its code views hovering a line shows GitHub's "+" in the gutter (`apps/client/src/review/addCommentGlyph.ts`);
a click opens a comment box under the line, and drafted comments stay there as cards
(`apps/client/src/review/ReviewCommentZones.tsx`, stored as `reviewComments` in `sessions.json`) until the review goes
out. A draft on a line of a diff hunk (blue "+") is posted inline through the REST API
(`apps/client/src-tauri/src/session/review.rs`); a draft elsewhere (grey "+") becomes a note in the review summary with
the commented lines as a code block. "Comment on file" in the header of the diff views drafts a comment on the whole
file, shown above its first line; GitHub's REST API cannot take those with a review, so the review is then created
pending, gets them through GraphQL and is submitted there (`apps/client/src-tauri/src/github.rs`). The review threads
already on GitHub show as cards under their lines as well, with the avatar of whoever opened them before the lines and
every reply below; resolved threads stay collapsed. They are loaded through GraphQL (`list_review_threads`) into
`apps/client/src/state/reviewThreads.ts` when a file shows and they are older than 30 seconds, and right after a review
was submitted. A draft's card carries the avatar of the account `gh` is logged in as. Every card ends in GitHub's "Write
a reply". A reply is drafted like a comment ("Start a review" / "Add review comment", stored with `replyTo`) and shows
as "Pending" in its card until the review goes out: a reply to a draft joins the thread that draft opens (or its note),
a reply to a thread on GitHub is added to the pending review through GraphQL. While nothing is drafted, "Add single
comment" posts a reply to a GitHub thread right away. "Resolve conversation" resolves a GitHub thread (or unresolves it)
at once; a reply whose thread is gone keeps a card of its own.

#### Editor

The "Editor" tab is a small built-in IDE for the worktree: a lazily listed project tree
(`apps/client/src-tauri/src/workspace.rs`) and Monaco editor panes with tabs and a symbol breadcrumb
(`apps/client/src/ide/`). A folder's context menu marks it with a color that tints it and everything below it, like
WebStorm's file colors; marks are kept per repository in `apps/client/src/ide/folderColors.ts`. Files live as
`file://<worktree>/…` models.

Hover, inlay hints, diagnostics, the breadcrumb, go-to-declaration and usages come from the TypeScript 7 language
server (`tsgo --lsp`, from the worktree's `node_modules/.bin` or the PATH), one process per worktree managed by
`apps/client/src-tauri/src/lsp.rs` and bridged through `apps/client/src/ide/lsp/`. Monaco's bundled TypeScript worker
only colors code: `apps/client/src/diff/webstormClassifier.ts` assigns every identifier the role WebStorm would (class,
interface, instance field, static method, parameter, global/local variable, …), colored by the user's WebStorm scheme
(`apps/client/src/diff/webstormScheme.ts`); opening a file also loads its relative imports so imported names get their
roles.

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
(`docs/adr/NNNN-title.md`, or the existing ADR folder), one tab each (`apps/client/src/guardrails/`). Instructions,
rules and skills are shown in a tree of the worktree's folders, since Claude Code also reads a `.claude/rules` or
`.claude/skills` below any folder once it works on a file there; the "+" of a folder creates an entry in that folder's
`.claude`. Entries open in a Markdown editor. "New …" and "+" open the page of a new file with the kind's template (ADRs
are numbered after the highest existing one) and its agent chat; the file is written only once the template was edited
or the agent wrote it, so no template file and no empty folder is ever left behind. ⌘S or "Save" writes an open file.

Opening a session checks that the worktree's root `CLAUDE.md` names the ADR folder and otherwise offers once to
append an "Architectural decisions" section with the `ls`/`grep` lookup
(`apps/client/src/guardrails/adrInstruction.ts`); without it Claude Code never reads the records. A decline is
remembered until the app restarts.

#### Architecture diagrams

The Architecture tab shows one of six diagrams per session, picked in the dropdown of its toolbar and remembered per
session: *Dependencies* (the file-level component diagram of the change) and the five shape diagrams *C4 Context*,
*C4 Container*, *States* (UML state diagram), *ERD* (entity-relationship diagram) and *Process* (UML activity
diagram). Every diagram is content the agent writes into a git-excluded file of the worktree during a hidden turn,
and a view Hunt renders from it; the generate button runs the standard prompt of the chosen type, and the chevron
beside it opens a box for additional instructions that go along with that one run. For the turn the session's agent
switches to the model and effort from Settings → Agent (default `claude-opus-5-5` with `high`) and back to the
chat's choice afterwards. The prompts name the session's diff base: `HEAD`, or the merge base of a reviewed pull
request. `apps/client/src-tauri/src/graph.rs` owns the prompts, the files and their status; the React panels live in
`apps/client/src/graph/` (`ArchitecturePanel.tsx` picks the view, `GraphPanel.tsx` is the Dependencies view,
`ShapeDiagramPanel.tsx` the five others).

The Dependencies diagram is `.hunt/graph.json` (schema in `apps/client/src-tauri/src/graph.schema.json`): one node
per changed file plus the unchanged files that explain the change, and one edge per dependency with a label stating
how the source uses the target (one to three words, a verb, a noun or both, in the AI language from the settings)
and a description of how it is used. Hunt validates it, fills pairs the agent left out with unlabeled edges read
from the import statements and lays it out with ELK inside React Flow. Opening the tab without a diagram generates
one as soon as the agent is idle.

A shape diagram is `.hunt/diagram.<type>.json` (`diagram.c4-container.json` and so on; schema in
`apps/client/src-tauri/src/diagram.schema.json`, which the prompt also copies into `.hunt/`): nodes with a kind
(`person`, `system`, `container`, `database`, `table`, `state`, `decision`, …), label and description, optional
boundary groups, and edges with a label, a description, the ERD's columns and cardinalities, plus a `change` mark on
everything the session added or altered. The file holds content only: shapes, colors, sizes and layout are Hunt's
(`shapeNodes.tsx`, `shapeDiagram.ts`), so the same diagram looks the same on every branch. The prompts live in
`apps/client/prompts/diagram/`: `diagram.system-prompt.md` extends the agent's system prompt with the rules shared by the five
types, `diagram-<type>.user-prompt.md` is the message of one type. A shape diagram is generated only on a click.

The modification time of a diagram file is the time it was generated; every session records in `sessions.json` when
it last changed worktree files (agent edits via the change attribution, saves in Hunt panes, revert, shelve,
unshelve), and the panel marks the diagram "Outdated" once such a change is newer than the diagram (`graph_status`
command).

#### Remote sessions

A session can move to a Compute Engine VM of its own and keep working there while Hunt is closed ("Remote" in the chat
header, set up under *Settings → Remote VM*: the Google Cloud project of the gateway and the machine type of new session
VMs). The app
creates, starts and deletes no VM itself: it calls the gateway API (`libs/domain/src/gatewayApi.ts`,
`apps/client/src-tauri/src/remote/api.rs`) as `hunt-api <method>` over its SSH connection to the gateway, with the
request as one JSON object on stdin; stdout streams NDJSON events, progress steps and log lines, then one result or
error. The app passes session IDs and, to `sessions.provision`, the chosen machine type: one of
`libs/domain/src/sessionMachineTypes.ts`, which the gateway checks and uses only for a VM it creates, or none for the
template's. The gateway names the VM `vm-hunt-s-<short id>` (`<short id>` is the first 8 hex digits of the session ID)
and owns its project, zone, instance template and preview domain, which `hello` reports.
The first call to a gateway in an app run checks that its `hello.api` is the `api` of `libs/domain/protocol.json` and
otherwise asks to update Hunt or to wait for the next server deploy. The handoff calls `sessions.provision`; a connect
calls `vms.get` and reaches a running VM directly, since the gateway's `vms.start` also waits for the boot and checks
the release over `gcloud compute ssh`, which takes seconds, and calls `vms.start` only for a VM that is off or does
not answer; diffs call `vms.get`, deleting a session calls `vms.delete`, adoption calls `sessions.list`, and the remote
secrets of *Settings → Remote VM* call `secrets.list`, `secrets.set` and `secrets.delete`. So the
gcloud login needs no Compute Engine rights to change VMs: Hunt uses it for the IAP tunnel to the gateway and the
session VMs, for registering its SSH key with OS Login, and once per app run to find the gateway, the VM of the project
labelled `hunt-role=gateway`, with its zone (`gcloud compute instances list`, which needs `compute.instances.list`, e.g.
from `roles/compute.viewer`). The infrastructure repository sets that label and configures the gateway, the session
VMs' instance template with their default machine type and boot disk, and the poller below. The main window passes the remote settings to
the backend at its start and on every change (`set_remote_settings`); commands on stored remote sessions reach that gateway. After the
gateway started or provisioned a session VM, Hunt checks that the VM's release speaks the app's protocol (`hunt-ctl
version`, `apps/client/src-tauri/src/remote/release.rs`, numbered in `libs/domain/protocol.json`) and runs `hunt-ctl
install-tools`, which installs the agent's tools the VM image lacks in the versions the VM's release pins and skips
those at their version already. The app installs no release itself.

The VM side is released and deployed by CI, separately from the app. `scripts/buildVmArtifact.ts` builds the release
of each VM role (`nx run gateway:build`, `nx run session:build`): esbuild bundles every Node entry point into one
`.mjs` file that needs nothing but Node, and the script lays these out with `hunt-ctl`, the systemd units, the VM's
configuration files, `.version`, `protocol.json` and `.hash` (the first 16 hex digits of a SHA-256 over every other
file) as `/srv/hunt/current` expects (`gateway/`, `relay/`, `session/`, `vm/`) in `dist/apps/<role>`. The deploy
reaches the gateway over SSH: `hunt-ctl install <dir> --domain <domain>` installs the gateway's release (later installs
keep the stored preview domain without `--domain`), and `hunt-ctl stage-session <dir>` keeps the session release in
`/srv/hunt/session-releases/<hash>`, points `/srv/hunt/session-current` at it and keeps the one before. Each time the
gateway provisions or starts a session VM, it compares the VM's `/var/lib/hunt/installed-hash` with the staged
release's `.hash` and, when they differ, packs the staged release, unpacks it on the VM into
`/srv/hunt/incoming/<uuid>` and installs it there with its own `hunt-ctl install` (`apps/gateway/src/sessionVm.ts`).
`hunt-ctl install` and `stage-session` refuse a folder without `.version`, which is what older Hunt apps push. A relay
that runs keeps running and starts on the new release with its next start.

A handoff (`hand_off_session`) stops the local agent and pushes the branch plus a snapshot commit of the uncommitted
work (`refs/hunt/<id>/handoff`) into the session's repository on its VM, `/home/agent/<repository name>`, so the handoff
needs no access to GitHub. The Git LFS objects of the checkout, the private files the services of the worktree's
`hunt.json` name (`worktreeInclude`, listed as for a new worktree) and the Claude Code transcript follow, the transcript
with its paths moved to the VM. The
agent's `~/.claude` there (`/home/agent/.claude`) also gets the user's `CLAUDE.md`, `rules/`, `skills/`, `agents/`,
`commands/` and `output-styles/`, and the memory of the repository (`projects/<slug of the main checkout>/memory/`);
`settings.json` and plugins stay on the Mac. `libs/vm/hunt-ctl` checks the branch out there; `hunt-ctl
session-config` writes the session's services and preview proxy from the repository's `hunt.json` and returns the list
of services and the repository's `hunt.agent.md`, which Hunt appends to the agent's system prompt. Then `hunt-ctl`
installs the dependencies and starts the
relay with the OAuth token of the selected Claude account, which Hunt passes on stdin; the local login stays on the
Mac, so a remote session needs a token account. Every connect sends the token of the account selected now, and a relay
that runs with another one restarts with it between turns (`hunt-ctl start`), so a prompt from Hunt runs with the account
picked in Hunt, as it does locally; while a turn runs, the relay keeps its account until its next start. A failed handoff removes the session's worktree from the VM but keeps
the VM (`leftoverVm` in `sessions.json`): the next attempt skips the first boot, and deleting the session deletes it.

With a GitHub token under *Settings → Remote VM* (`apps/client/src-tauri/src/github_token.rs`, kept in the keychain),
the agent pushes and runs `gh` as the user: the token goes on stdin next to the Claude token, `hunt-ctl` keeps it in
`/etc/hunt/github-token` (root and `agent` read it), `/usr/local/bin/gh` is Hunt's wrapper (`apps/session/vm/hunt-gh`)
that exports it as `GH_TOKEN` for each run of the real gh, the repository there gets `origin` as
`https://github.com/<owner>/<repo>.git` with the branch's upstream, and git and Git LFS authenticate through gh's
credential helper. Nothing holds the token in its environment, so a token replaced on the VM counts from the next
`gh` or git call on. A repository's `core.hooksPath` inside the worktree (husky's `.husky`) comes along with its
ignored files, so commits and pushes on the VM run the same hooks; without one, Git LFS's hooks upload LFS files on
push. Everyone with root on the VM can read the token, so it should be a fine-grained token limited to the
repositories handed off. A session the gateway's poller started for a `swf` issue keeps the poller's tokens
(`RemoteOrigin::keeps_vm_tokens`): connecting to or clearing it runs `hunt-ctl start` and `clear` with `--keep-stored`,
which keeps the tokens stored on the VM and takes the ones Hunt sends only where the VM stores none, so everything its
agent does on GitHub happens as the poller's GitHub App, and so does a push from Hunt's changelist (`hunt-ctl push
--stored`). Connecting while the poller still sets the session up fails until its relay runs, since nothing is stored
yet.

Values a service needs that the repository does not hold, such as an API key, are remote secrets
(`libs/domain/src/remoteSecrets.ts`): *Settings → Remote VM* lists them by name with the last four characters of
longer values, adds, replaces and deletes them through the gateway, and never reads a value back. The gateway keeps
all of them as one JSON object in the latest version of the Secret Manager secret `HUNT_REMOTE_SECRETS`
(`apps/gateway/src/remoteSecretStore.ts`; a change adds a version and destroys the others) and puts the object on every
session VM it brings up for a handoff, a start or the poller (`hunt-ctl put-remote-secrets`,
`/etc/hunt/remote-secrets.json`, which only root reads). A service of `hunt.json` names the ones it needs under
`remoteSecrets` (`"OPENAI_API_KEY": "$MED_OPENAI_API_KEY"`), and `session-config` writes them into its environment file;
a name without a remote secret fails `session-config` like any other problem of `hunt.json`. A changed value reaches
the sessions that start or are handed off afterwards. While the gateway may not read the secret, the session VMs get
none and the journal says why.

The relay (`apps/session/src/relay/`) runs on the VM as the systemd service `hunt-relay` of the user `agent`: it owns
the ACP adapter, loads the conversation once and serves it over `/run/hunt/relay.sock`. Hunt's agent process for the
session is then `ssh … sudo -n -u agent socat - UNIX-CONNECT:/run/hunt/relay.sock`, so the chat works as before; a
client that connects later gets the conversation replayed, and the relay reports a running turn. Several clients, such
as the Hunt apps of different people, can be attached at once: each gets every update live, their prompts run one after
another, and a permission request goes to all of them; the first answer counts, and the relay withdraws the request from
the others. The guardrails stay local and wait until the session comes back; diff, editor, graph and pull request work
on the local worktree, which Hunt keeps in sync with the VM (below). For every tool call the agent finishes, the relay
writes one line to the journal, which the Ops Agent ships to Cloud Logging (`toolCalls.ts`): tool, status, duration,
for a command its exit code and number of output lines, and the title, for Bash the whole command. The output stays
out.

A sub chat of a remote session (sub session) runs on this Mac, in the session's local worktree, wherever its session
runs: its agent is a local one, what it changes reaches the VM through the session's file sync like an edit in the
editor, and its commits and pushes go through the VM like the session's. Its transcript lives in the local project
folder, so a handoff and a retrieval leave it alone; both stop the sub chats' agents while the worktree moves, and a sub
chat starts again when it is opened next. While a sub chat runs a turn, the chat header offers neither the handoff nor
bringing the session back, since either would cut the turn short. A sub chat that ran on a VM with an earlier release
(protocol 7 and before) continues here with its transcript as the sync backed it up after its last finished turn.

The agents that share a worktree learn of one another from `.hunt/sessions.md`, which Hunt writes there
(`apps/client/src-tauri/src/session/related.rs`) and the system prompt points at
(`libs/domain/prompts/sessions.system-prompt.md`, with the agent's own Hunt session id filled in): every session of the
worktree (the session and its sub chats) with its Hunt session id, role (the session, or a sub chat with the selection
or task it was opened from), title, whether its agent works right now, where it runs and the path of its transcript on
each machine that has a copy, plus the summary bullets. The file is written anew whenever the stored sessions change, a
session gets its title, an agent starts or stops or a turn starts or ends, and a connected remote session's copy goes
to its VM a moment later (`sync::copy_files`, as the diagram does). `.hunt/` is excluded from Git and left out of the
file sync, so the file never reaches the repository.

Every session has a VM of its own, which is the isolation boundary: the agent works there as the user `agent`, with
Docker and Docker Compose, and starts the services of the repository's `hunt.json` its task needs. `libs/vm/hunt-ctl`
runs every git, tar
or file operation in the session's files as `agent`, so the agent's hooks, Git config and symlinks act with no more
rights than the agent has anyway. Files that come back from the VM are copied without following symlinks.

`/etc/hunt/role` tells `hunt-ctl` whether it runs on a session VM or on the gateway, and so which release it installs.
On a session VM, `hunt-ctl install` puts the release under `/srv/hunt/releases/<hash>`, and `hunt-ctl install-tools`
adds what the agent works with besides the VM's base image: build tools, gh, Terraform, Volta for the Node and npm
versions a repository pins, the ACP adapter in the version `apps/session/acp-version` pins, with the native Claude Code
CLI, and Playwright's MCP server with Chromium (`apps/session/playwright/`, offered to Claude Code through
`apps/session/mcp-servers.json`); a tool that is at its version already is skipped. The image build of the session VMs
runs it, so an image holds the tools; the app and the poller run it on every VM they set up, for an image that lacks
some. The relay runs as `hunt-relay.service` (`apps/session/vm/systemd/`) with the agent's
environment (`apps/session/vm/agent.env`), `HUNT_PREVIEW_URL_TEMPLATE` and the Claude Code token and Git identity of
`/etc/hunt/secrets.env`, which only root reads. A restart of the relay, such as `/clear`, leaves the services and the
tmux session running. Login shells of `agent`, such as the terminal's tmux session, get the same environment without
the Claude Code token (`/etc/profile.d/hunt.sh`); `gh` and git reach GitHub from them as from the agent, through the
wrapper and `/etc/hunt/github-token`.

`hunt-ctl session-config` reads the repository's `hunt.json` (contract version 3, `apps/session/src/config.ts`). It
lists every service of the repository, a monorepo all of its apps, with its `command`, an optional `cwd`, its `port`,
`tls` (the port speaks HTTPS), `guarded` (behind IAP, the default) and `env`, whose values may name a service's URL as
`${services.<name>.publicUrl}`, `remoteSecrets`, variables whose values are remote secrets (`"$<NAME>"`, see "Remote
sessions"), and `worktreeInclude`, the ignored files the service needs, as glob patterns, which every worktree and
session VM gets from the checkout (see "Worktrees and changes") and the VM only validates.
`session-config` writes one environment file per service to
`/etc/hunt/services/<name>.env` (mode 0600, read by systemd only), the session's environment `/etc/hunt/session.env`
and the configuration of the VM's preview proxy, `hunt-proxy.service` (Caddy on port 8080), which serves `<short id>-<port>.<domain>` from that port on
localhost (servers bound to 127.0.0.1 or ::1) and `<short id>-<port>-open.<domain>` from the ports of services with
`"guarded": false` only, keeps the Host header and logs every request to `/var/log/hunt-proxy/access.log`. When nothing
listens on the port, it answers 503 with a line that names the service of that port. Every service
runs as `hunt-service@<name>.service` (`apps/session/vm/systemd/`) as the user `agent`, with its own variables, and
writes its output to `~/logs/<name>.log`. The agent starts the services its task needs, as the repository's
`hunt.agent.md` groups them, with `sudo -n hunt-ctl service start|restart|stop|status <name>…`, the only commands
`/etc/sudoers.d/hunt-service` allows it. Right after the handoff of a session whose chat holds a prompt, when no prompt
is queued, hunt.json declares services and none of them runs, Hunt asks the agent in a turn of its own to start what its
task needs (`HANDOFF_START_PROMPT` in `apps/client/src/preview/services.ts`); when its task leaves that unclear, the
agent starts nothing. A started service stays enabled and starts again with the VM; bringing the
session back or deleting it stops and disables every service. `hunt-ctl preview-status` reports the state of every
service, whether its port answers on localhost and the ports that listen on all or the loopback addresses.

The gateway, a VM that runs all the time, routes `https://<short id>-<port>.<domain>` to any port of the session VM; the
load balancer in front of it lets only IAP's access group through, and a request for a VM that is off starts it.
`https://<short id>-<port>-open.<domain>` reaches the services marked `"guarded": false` without IAP, so a UI behind IAP
can call its backend on a host of its own, as it does locally; only the app's own login protects them. The *Preview* tab
next to a remote session's chat (`apps/client/src/preview/PreviewPanel.tsx`) polls `preview_status`, which runs
`hunt-ctl preview-status <id>` on the VM, and shows every service with its state, URL and whether it answers, marks the
public ones and lists the other ports that listen, except the reserved ones (`RESERVED_PORTS`: Caddy, Docker, the
preview proxy, LLMNR and the Ops Agent), which no service may take and the preview proxy refuses; Hunt builds the URLs from the session ID and the preview domain the gateway reported at the handoff, the VM reports only
port numbers. While no service runs, *Start the app* sends the agent a normal prompt to start the services the task
needs, which starts a VM that is off.

The gateway keeps no sessions. Its edge proxy `hunt-edge` (Caddy in Docker on port 8080 behind the load balancer)
serves only the load balancer's address ranges, removes IAP's headers and cookies and forwards every preview host with
its Host header to `vm-hunt-s-<short id>.<zone>.c.<project>.internal:8080`, trying the session zones in their order
(below): the session VMs' internal DNS names are the whole routing table, and only the zone that holds the VM resolves.
A request it cannot deliver (502, 503 or 504, because the VM is off, still booting or in no session zone) goes to
`hunt-wake.service` on 127.0.0.1:9180 (`apps/gateway/src/wake.ts`). It looks the VM up in every zone through the
Compute Engine API with the gateway's service account, starts or resumes it for a page load, at most once every 30
seconds and never for a script's request of a tab already open, and answers with a page that reloads every 5 seconds
until the VM answers. A VM the gateway is moving to another zone (below) gets a reloading page as well; hunt-wake
itself never moves a VM, and a start it requests in a zone without capacity fails quietly until the session is
started from Hunt.
A second listener on port 8081 serves the load balancer's backend without IAP: it forwards only
`<short id>-<port>-open.<domain>` the same way and answers 503 for a VM that is off, without starting it.

The gateway API (`hunt-api.service`, `apps/gateway/src/api.ts`) is the control plane of the session VMs, with the
contract of `libs/domain/src/gatewayApi.ts`. It listens on the Unix socket `/run/hunt-api/api.sock`, which only the
system user `hunt-gw` opens. On the gateway, sshd forces `/usr/local/bin/hunt-api` (`apps/gateway/vm/hunt-api`) on
every user outside the group `google-sudoers` (`/etc/ssh/sshd_config.d/20-hunt-api.conf`, without a terminal, port or
socket forwarding, agent or X11 forwarding and `~/.ssh/rc`): it accepts only `hunt-api <method>` and runs the forwarder
`apps/gateway/src/apiClient.ts` as `hunt-gw` through sudo, the one command `/etc/sudoers.d/hunt-api` allows. The
forwarder sends one line `{caller, method, params}` over the socket, with sudo's `SUDO_USER` as the caller, and copies
the events to stdout; admins call `hunt-api <method>` the same way. `apps/gateway/src/apiProtocol.ts` checks the
method and params (session IDs are lowercase UUIDs, repositories `<owner>/<repo>`, branches valid Git branch names).
The VM methods go through `apps/gateway/src/orchestrator.ts`, which the poller uses as well: `sessions.provision`
creates `vm-hunt-s-<short id>` from `tpl-hunt-session` unless it exists in any zone. It tries the session zones in
order, `/etc/hunt/session-zones`, which `hunt-ctl install` writes from the gateway's instance metadata
`hunt-session-zones` (comma-separated, only zones of the gateway's region count; without it the gateway's own zone), and
moves on to the next only when Compute Engine reports a stockout (`ZONE_RESOURCE_POOL_EXHAUSTED`) for the machine type;
any other error of the creation ends the call. Changing the list takes effect with the next install, for the gateway and
the edge alike. A stopped VM whose own zone reports a stockout for its start moves to the first other session zone with
capacity, in list order: the gateway snapshots its boot disk (`vm-hunt-s-<short id>-move`), renames the VM to
`vm-hunt-s-<short id>-moving` and creates a VM from the template in the other zone with a boot disk Compute Engine makes
from the snapshot and the old VM's labels, machine type and metadata (a creation a stockout refuses leaves no disk
behind, and the following zone is tried), then deletes the renamed VM and the snapshot; when every zone is out, the VM
gets its name back and the call fails naming the zones. A disk can be snapshotted six times an hour, so repeated starts
while every zone stays out fail on the snapshot after that. The VM keeps its name and disk contents but gets a new
internal IP and instance ID, which the client records from the call's result. A move a crash left unfinished is finished
or rolled back by the next `vms.start` or `sessions.provision` of the session, and `vms.delete` removes its leftovers.
A suspended VM whose zone is out of capacity for its resume is stopped first, which discards its saved memory, and then
moved the same way once it is off. The new VM is labelled `hunt-role=session`,
`hunt-session=<short id>`, `hunt-origin=desktop` and `hunt-owner=<caller>`, records the session's ID, repository,
branch and title in its metadata and refuses a VM that holds another session (`conflict`); it and `vms.start` start a
stopped VM, resume a suspended one, wait out a shutdown in progress, wait until the VM answers over SSH and its startup
script wrote `/var/lib/hunt/session-ready` (the same command puts the remote secrets on it), install the staged session release,
streaming `creatingVm`,
`startingVm`, `movingVm`, `waitingForVm` and `installingRuntime`. Concurrent calls of one method for one session share one
operation; the second hears its progress from the start. `vms.delete` deletes the VM with all its disks and answers
`alreadyGone` for a VM that does not exist; `sessions.list` lists the session VMs of every zone of the project.
`secrets.list` answers names and hints only, `secrets.set` and `secrets.delete` change one remote secret at a time, and
the journal names the secret, never its value.
Running requests go on when their caller disconnects, and a reload after
an install lets them finish before the new release starts. `journalctl -u hunt-api` shows one line per request with its
caller and its outcome, and one per Compute Engine call (method, resource, HTTP status, duration) and per command on a
session VM (what it does, outcome, duration, and the end of stderr when it failed).

`hunt-api`, `hunt-swf` and `hunt-wake` run as `hunt-gw`, which `hunt-ctl install` creates. `hunt-firewall.service`
keeps every other user on the gateway, containers and the edge proxy included, off the metadata server, whose token
can create, start and delete VMs; only root and `hunt-gw` reach it, and everyone keeps DNS and NTP through it.

Next to the preview, the *Terminal* tab (`apps/client/src/terminal/TerminalPanel.tsx`, xterm.js) shows one tab per
process of the app, like the tabs of a local terminal. Each service of `hunt.json` gets a read-only tab that follows its
log (`tail -n 5000 -F ~/logs/<name>.log`); `hunt-service` sets `FORCE_COLOR=1` unless the service's `env` sets it, so
tools keep their colors in the log. Each window of the tmux session `app`, in which the agent runs its other
long-running processes, gets a tab that takes input: it attaches to a tmux session of its own grouped with `app`
(`hunt-view-<terminal id>`, no status bar, mouse on, destroyed with the terminal), so several tabs show different windows
at once. "+" opens a shell in a new window `shell`, × ends a window after a confirmation. The panel lists the windows
(`tmux list-windows`) and the services (`preview_status`) when it shows, then every 5 s while the session is connected.
The backend (`apps/client/src-tauri/src/remote/terminal.rs`) runs `ssh -tt … sudo -n -iu agent …` in a local pseudo
terminal (`portable-pty`), so the programs see a real TTY and keep their colors. A terminal joins the shared SSH
connection when one is open but never starts it, and streams its output to the window that opened it as base64 chunks
(`terminal:output`, then `terminal:exit`). It connects when its tab is first shown, stays connected while another tab
shows, and ends when its process is gone, with the session's panel, its window or a reload; the processes keep running.
A VM that is off is not started for it.

While a remote session is connected, Hunt syncs its files between the worktree on the VM and the local worktree in
both directions (`apps/client/src-tauri/src/remote/sync.rs`, triggered by `apps/client/src-tauri/src/session/sync.rs`),
so the *Diff*, *Editor*, *Architecture* and *PR Description* tabs work as for a local session, next to *Preview* and
*Terminal*, and edits made here reach the agent. Each side lists the files Git sees there (tracked and untracked, not
ignored, so no `node_modules` or `.env*`) with size, modification time, execute bit and whether they are links; the
state after the last sync, kept in `remote-sync/<id>.json` in the app data folder, tells which side changed a file. A
file changed here goes to the VM, also when the agent changed it too (the local version wins), unless its content is
still the one of the last sync; a file changed only on the VM comes here; deletions follow the same rule; equal size,
modification second and mode count as in sync. Before the first sync, a file counts as changed here only when it
differs from the snapshot both sides started from (`refs/hunt/<id>/handoff`, or for an adopted session
`refs/hunt/<id>/adopted`); otherwise it takes the VM's version. Later, a file without a recorded state counts as
changed here only when it exists here in another state than when the sync left it alone; one that is missing here comes
from the VM.
A file that exists on a side without being listed there (other ignore rules on the Mac and the VM) is never touched.
On a case-insensitive Mac the VM's spelling wins, and two VM files whose names differ only in case are reported instead
of synced. rsync (`hunt-ctl install-tools` installs it on the VM) copies the files over the session's SSH connection as
`agent`, links go to the VM as their text: files from the VM land in `.hunt/sync-staging` first (links last) and
replace a local file only while it is unchanged since the listing, never below a local link and never as a link that
could lead outside the worktree. A link the agent makes with an absolute target (`ln -s /…`), or one whose target
climbs after a name (`a/../b`), is not brought here: the chat names it on every sync, and bringing the session back
refuses until it is gone. Replace it in the terminal of the VM with a relative link that climbs only at its start
(`../shared/config.json`), with a copy of the file, or delete it. What completed is recorded even when a later step fails, and a file that cannot move (a folder on the
other side) is reported in the chat without stopping the rest. The listing and the deletions on the VM run as `agent`
through `sudo`, so they do not keep the VM awake. The sync is live (below): a change on either side reaches the other
within about 0.1 s. A full sync, which lists both sides, runs when the session connects, when the live channel
(re)opens or asks for one, after every turn that ends, and whenever a live sync cannot tell a change file by file (a
folder moved here); a save, move, delete, revert or shelve in Hunt has the local side listed anew, and a prompt and a
diagram refresh wait until local changes reached the VM. Without the channel (a VM on an older release, or while it
reconnects) a full sync also runs after every tool call and every 10 seconds while a turn runs. After every sync that
may have moved either, the session's branch points at the same commit here and on the VM
(`apps/client/src-tauri/src/remote/commit.rs`): when the agent committed on the VM, the local branch follows (the commit is
fetched as `refs/hunt/<id>/head`), and when a commit was made here, with Hunt's changelist or any tool in the local
worktree (seen through the worktree's `logs/HEAD`), the VM's branch follows (the commit goes there as
`refs/hunt/<id>/local`); the following side keeps its files, which the sync made equal already, so the diff shows what
is uncommitted on both sides, as for a local session. When both sides committed since they last agreed, neither
follows, and the chat says so with the reset to make.

The Claude Code transcripts move beside the files, live and both ways (`apps/client/src-tauri/src/session/transcripts.rs`,
`remote/transcript_sync.rs`): the transcript helper on the VM (`apps/session/src/sync/transcripts.ts`, started over the
same SSH connection as the sync helper) watches the agent's project folder `~/.claude/projects/<slug>` there and reports
every file the agent writes (the session's transcript, its subagent transcripts, tool results; the memory excepted) as
it grows, from the offset this Mac holds, and Hunt appends the complete lines, with their paths moved here, to a mirror in
the local project folder of the worktree, so a sub chat can read the running turn of its session. The other way, Hunt
watches the local project folder and sends the files this Mac owns, the transcripts of the session's sub chats, to the
VM's project folder the same way, so the agent on the VM can read what its sub chats did. Every offset is remembered per
side (`remote-sync/<id>.transcripts.json` in the app data folder), so a channel that reopens asks only for what is
missing; a mirror that changed under the stream is pulled from the start again, and a VM copy that is not as long as
expected is sent from the start again. The protocol is in `apps/session/src/sync/transcriptProtocol.ts`. While the
stream has no channel (a VM on an older release, or while it reconnects), the sync after every turn that ends copies
the session's transcript from the VM into the local project folder instead, as a backup for a VM that gets lost
(`back_up_transcripts` in `apps/client/src-tauri/src/remote/retrieve.rs`); the backup and the retrieval leave the sub
chats' transcripts alone, whose copies on the VM are the stream's. The records from the VM keep its permission mode
until the session runs here again, and the memory stays on the VM for the merge below. The
changelist's *Commit* commits the checked files in the local worktree, with this Mac's Git, hooks and identity, as for
a local session, after a sync that sent the local edits to the VM and while no other sync runs; the VM's branch then
follows the commit. *Push* pushes the commits to the branch the session was created from on `origin` from this Mac
with its Git credentials, as for a local session, once the branch points at the same commit here and on the VM; when
that branch on `origin` moved on, the local branch is rebased onto it here, with the local Git identity, and the VM's
branch moves to the rebased commit (`remote::commit::move_vm_head`: the commit goes to the VM, whose worktree is reset
to it with its uncommitted changes stashed meanwhile). Only a poller session's branch is pushed from its VM
under its own name with the poller's stored token (`hunt-ctl push --stored`), so that the push shows the GitHub App
like its agent's commits.
*WebStorm* is switched off for a remote session and its sub chats. Its `node_modules` install leaves the lockfile alone (`npm ci`, `--frozen-lockfile`). The chat header
shows when the last sync succeeded, and the chat shows a failure. A diagram refresh runs on the agent on the VM,
against the session's diff base, and Hunt copies `.hunt/graph.json` back afterwards. Known limits: an edit that keeps
a file's size within the same second it was last synced in goes unnoticed until the next change, and line-ending
conversion (`core.autocrlf`) makes the two sides' contents differ, so it should stay off for remote sessions.

The live sync runs over a channel to a helper on the VM that the client starts over the session's shared SSH
connection and keeps open (`sudo -n -u agent /opt/hunt/node/bin/node /srv/hunt/current/session/syncHelper.mjs
<worktree>`, `apps/session/src/sync/`; client side `apps/client/src-tauri/src/remote/channel.rs`). The helper watches
every folder of the worktree that Git does not ignore and speaks NDJSON on stdin and stdout
(`apps/session/src/sync/protocol.ts`): it reports changed files with their state and, up to 1 MiB, their content,
applies the writes, links and deletions the client sends and acknowledges them without echoing them back, says when
`HEAD` may have moved and asks for a full sync after a change of the ignore rules or a failed watch. The local watcher
reports paths after 50 ms. A live sync plans like a full one, from both listings as the last sync left them with only
the reported paths replaced, and moves small files through the channel and larger ones with rsync; measured with
7,373 files at the round trip of IAP, a change takes about 80 ms from the VM here and 50 ms the other way. When both
sides change the same file within that time, the local version wins and the chat names the file. The channel opens
again after it ended, waiting 1 to 30 seconds after each failure in a row, and the full sync after it brings what
changed meanwhile.

Only one side writes while the two cannot sync (`apps/client/src-tauri/src/session/link.rs`). The local worktree may
change while the channel is open or the agent of the VM is connected, and while the gateway says the VM is off (the
next sync sends the changes). Otherwise it is locked: the VM runs without a connection here, or neither it nor the
gateway can be reached. Hunt then refuses its own writes (saves, moves, deletions, revert, shelve, unshelve, commit)
and its editors turn read-only; editors outside Hunt are not held back. A chat of the locked worktree (the session's or
a sub chat's, in the chat pane or the sub chat popover) connects the session to its running VM on its own
(`apps/client/src/chat/useVmConnect.ts`), which brings the sync back and lifts the lock, and shows the connect's step
meanwhile; only a failed connect offers *Connect* to try again, and a VM that cannot be reached offers *Continue
locally*. A locked session is checked again every 15 seconds. *Continue locally*
(`continue_locally`) makes the session local with the files as last synced and the conversation as of the agent's last
finished turn; once the VM can be reached (tried every minute and at each start of Hunt), Hunt stops the session
there, fetches a snapshot of what the agent left as `refs/hunt/<id>/abandoned` and deletes the VM.

Bringing it back (`retrieve_session`) stops the relay, syncs once more, snapshots the VM's worktree on top of the
agent's commits (`refs/hunt/<id>/retrieve`) and fetches it. Files only the VM has that this Mac ignores (global
excludes, files the agent added with `-f`) are brought here once nothing else differs, and only where this Mac has
no file of that name or the same one; another local version stays and is named. Files only this Mac has that the VM
ignores stay.
Only when the snapshot then holds the files of the local worktree, the local branch holds no commit the VM lacks and
nothing changed here meanwhile does the branch move to the agent's last commit; otherwise the retrieval names each
differing file with its side and the ignore rules that apply (or the local commits) and moves nothing.
The transcript returns and gets the session's permission mode from before the handoff in place of the VM's. Then Hunt has the gateway delete the
VM with its disks (`vms.delete`), as it does when a remote session is deleted. A session whose VM no longer exists
(deleted by the gateway after a week off, see below, or outside Hunt) comes back with what this Mac has, the local worktree as the file sync left it and the
conversation as of the agent's last finished turn, which the sync backed up, as soon as it is brought back or a prompt
tries to connect it; the chat says so, and the session can be handed off again. A deletion that fails, for example
offline, is kept in `remote-cleanups.json` in the app data folder and retried at the next start of Hunt, once the main
window passed the remote settings. Hunt deletes no VM whose recorded name is not the session's `vm-hunt-s-<short id>`.
What the agent changed in the memory is merged into the local one three-way against what the handoff sent
(`apps/client/src-tauri/src/remote/memory.rs`): a file only the VM changed takes its version, one both sides changed
keeps the local version with the VM's next to it as `<name>.remote-<id>.md`, and `MEMORY.md` takes the VM's added and
removed lines.

The gateway's poller `hunt-swf.service` (`apps/gateway/src/swf.ts`) starts a session for every open GitHub issue
labelled `swf` in the repositories that the gateway's instance metadata `hunt-swf-repos` lists (comma-separated
`<owner>/<repo>`), with at most `hunt-swf-max-sessions` (default 2, at most 10) at once. The infrastructure repository
sets both; the poller reads them from the metadata server at every poll, so a change needs no restart, and an invalid
value keeps it idle. Every 30 seconds it lists the open issues through GitHub's REST
API and, while fewer of its VMs
(label `hunt-origin=swf`, any status but `TERMINATED`, `STOPPED` and `SUSPENDED`) are up than the limit allows, claims the oldest
issue: `swf` becomes `swf:running` (the labels `swf:running`, `swf:question`, `swf:done` and `swf:failed` are created
when missing) and a comment names the session's preview hosts. Then it does what a handoff does, with the gateway's service account instead
of a Mac: the orchestrator creates `vm-hunt-s-<short id>` from the configured instance template (labelled
`hunt-origin=swf`, without an owner), records the session, repository,
branch `feat/general/<issue>-<slug of the title>` (`fix/general/…` for an issue labelled `bug`), title and issue in the
VM's metadata, waits for the startup script and installs the staged session release, over `gcloud compute ssh
--internal-ip` (OS Login as admin, one shared SSH connection per VM); `hunt-ctl install-tools` follows.
`hunt-ctl clone` clones the repository from GitHub as `agent` onto the branch (the origin's branch of that name
when it exists, else a new one from the default branch) with the App's bot as Git identity (`<slug>[bot]`,
`<id>+<slug>[bot]@users.noreply.github.com`, passed as `--git-name` and `--git-email`). The repository's
private files follow through `put-files` when the Secret Manager secret `HUNT_SWF_FILES_<owner>_<repo>` (every
character a secret name cannot hold becomes `_`: `HUNT_SWF_FILES_unshoppable_app-framework`) holds a version: a gzipped
tar archive of the ignored files a handoff copies from the Mac, such as `.env.private`, with paths relative to the
repository's root and at most 64 KiB, which the infrastructure repository's README shows how to add. A secret without
a version, or one the gateway may not read, means no private files and a warning in the journal; a version that is no
such archive fails the setup. Then `session-config`,
`put-files --claude` with `hunt-session.json`, `deps`, `start` and `wait` follow as in a handoff. The system prompt is
the remote, Git and question parts a handoff appends (`libs/domain/prompts/`, which the app and the poller compile in),
the poller's own `apps/gateway/prompts/swf.system-prompt.md` with the issue's workflow, the repository's services and
its `hunt.agent.md`; the parts Hunt takes from its user's settings (response style, guardrail offer, diagram language)
do not exist on the gateway. The poller then sends the issue with all its comments as the first prompt through the
relay and disconnects; the relay runs the turn without a client. The workflow has eight steps: read the issue and the
repository's guardrails (README, CLAUDE.md, rules, skills, ADRs, `hunt.agent.md`); ask every question only a person can
answer in one comment on the issue, replace `swf:running` with `swf:question` and end the turn with the questions and
the marker `<!-- hunt:question -->` (the answer reaches the agent as its next prompt, from a Hunt desktop that opened
the session, and it takes the label back to `swf:running`); comment a short implementation plan on the issue and carry
it out without waiting for approval; then a loop of three steps until a pass finds nothing: implement the plan or the
last findings, check the change as a developer would locally (build, tests, linters, and for anything the user sees the
goal in the browser with the Playwright tools) and review the whole diff as a critical reviewer against the issue and
the guardrails, at most three passes before it asks the assignees with `swf:question`; push the branch, open a pull request with `Closes #<issue>`, the decisions it took and how it checked
the change, comment its link on the issue and watch the pull request's checks (a failure sends it back into the loop);
stop the services and tmux windows it started, delete its scratch files, leave the working tree clean and replace
`swf:running` with `swf:done`. When it cannot finish, it sets `swf:failed` with a comment instead. A setup that fails gets `swf:failed` and a comment with the error;
its VM stays for inspection.

Every poll also follows the agent of each running session VM the poller is not setting up: it reads the issue and
records the state its labels report (`running`, `question`, `done`, `failed`; a closed or deleted issue counts as
`done`) in the VM's metadata `hunt-agent` when it changed, which `sessions.list` reports as `agent` and the desktop
shows in its lists. While the issue is still labelled `swf:running`, `hunt-ctl status` tells whether the relay's turn
ended: then the poller reminds the agent once with a prompt that names the three ways out (finish, ask with
`swf:question`, give up with `swf:failed`), and when the reminded turn ends the same way it replaces `swf:running` with
`swf:failed` and comments that the VM keeps the session. While the issue is labelled `swf:question`, the poller watches
it for the answer: a comment by someone other than the app's bot user after the agent's question (the agent comments
through the app's token, so its question is the bot's latest comment) goes to the agent as a prompt
(`apps/gateway/prompts/swf-answer.user-prompt.md`) that tells it to take the label back to `swf:running`; a VM that
stopped meanwhile is started first through the orchestrator, and the next poll delivers the answer. No reminder and no
answer goes to a session a Hunt desktop is connected to. The reminders and the delivered answers live only in the
poller's memory, so after a restart a session may be reminded once more or get an answer a second time.

The poller acts on GitHub as a GitHub App (`apps/gateway/src/githubApp.ts`): its App ID and private key come from
Secret Manager (`HUNT_SWF_GITHUB_APP_ID`, `HUNT_SWF_GITHUB_APP_KEY`), as do the Claude Code OAuth token its sessions
run with (`HUNT_SWF_CLAUDE_TOKEN`), the private files of its repositories (`HUNT_SWF_FILES_<owner>_<repo>`) and the
remote secrets (`HUNT_REMOTE_SECRETS`). The
key signs a JWT per request; the poller exchanges it for an installation token per repository, valid for an hour and
scoped to that repository, and renews it twenty minutes before it expires. Its own REST calls, `hunt-ctl clone` and
`hunt-ctl start` take the repository's current token, and every poll gives each running session VM whose token the
poller has renewed the new one (`hunt-ctl github-token`, which replaces `/etc/hunt/github-token` without touching the
relay), whatever the issue's state; a VM that was stopped gets it on the first poll after its start. So the comments,
commits (author `<slug>[bot]`), pushes and pull requests of a poller session show the App, and a leaked token is worth
an hour on one repository. None of the key, tokens or files reaches a log line, a comment or a command line;
`journalctl -u hunt-swf` on the gateway shows one line per decision, Compute Engine call and command on a session VM.

The same service suspends idle session VMs (`apps/gateway/src/idle.ts`): once a minute it lists the running VMs labelled
`hunt-role=session`, runs the idle check of each (`hunt-idle-check --dry-run`, below) over SSH and suspends every VM
whose check reports `idle` through the Compute Engine API, waiting until Compute Engine has saved the VM's memory. A VM
that fails (one still booting does not answer over SSH yet, a suspend Compute Engine refuses) is logged once per failure.
It also deletes forgotten session VMs (`apps/gateway/src/reaper.ts`): once an hour it lists the VMs labelled
`hunt-role=session` and deletes, with all its disks, every one that Compute Engine reports as suspended or stopped for
more than 7 days (`lastSuspendedTimestamp`, `lastStopTimestamp`). Since a session VM is suspended half an hour after the
agent's, the client's or a preview's last activity, that is a week without anyone touching the session. Right before
deleting, it reads the VM once more and keeps one that was started meanwhile; a VM that names no session is only
reported. A session whose VM went this way continues on the Mac as described above, and `journalctl -u hunt-swf` shows
one line per suspend and deletion.

The labels and metadata of the session VMs are the directory of remote sessions. The start view's "Remote sessions"
button lists them as the gateway reports them (`list_session_vms`), sessions whose agent waits for an answer first,
then running ones. A row starts with the session's mark as the sidebar shows it: the sidebar's letter with its live
state for a session this Mac knows, else a `+` that runs an arc while the agent works and turns amber while it waits
for an answer, as the gateway recorded it; a chip names an agent that asks (amber), finished (green) or failed (red).
A click shows the session; the user chooses this way which session VMs the sidebar lists, since nothing adopts them on
its own. Opening a listed session this Mac does not know asks the gateway for it (`sessions.list`), keeps it when its
VM is in the gateway's region, whose zones the gateway creates session VMs in (`adopt_session_vms`,
`apps/client/src-tauri/src/remote/adoption.rs`), is named after the session and no local session has it: VMs the
gateway's poller started for `swf` issues (`hunt-origin=swf`, `hunt-issue`) and other people's handoffs. An adopted
session gets a record with origin `swf` or
`desktop`, its title, branch, repository and agent state from the metadata and the local checkout among the recently
used repositories whose `origin` is that repository; the sidebar labels it `swf #<issue>` or `remote`. At its start
and from the sidebar's *Refresh remote sessions* button Hunt runs the same listing without adopting anything, which
brings the agent state of the remote sessions this Mac has up to date (`remote.agent`), so the sidebar
marks a session whose agent asked on the issue before its conversation is loaded. Its worktree path on
the VM comes from `/srv/hunt/sessions/<id>/meta.json` once Hunt reaches the VM, and the relay replays its conversation
on `session/load`. Its first sync creates a new worktree in the local checkout on the branch the VM has checked out (a
numbered name when the checkout has that branch already), from a snapshot of the VM's worktree; until a checkout is
known it is not synced, and bringing it back is not offered. The × of a remote session in the sidebar (also ⌘W) only
takes it out of the sidebar (`close_session` with ending `forget`): its record, sync state and local worktree go, its
VM keeps running and the list of remote sessions brings it back; the dialog honours *Don't ask again* like a local
deletion. The red trash button beside the send button of a remote session's prompt box deletes the session with its VM
(ending `delete`), after a confirmation that for an adopted session names the other people working on it. Bringing an
adopted session back asks the same way; VMs this Mac deleted or still has to delete are never adopted again.

A remote session keeps its VM, which costs only its disk and its saved memory (about 0.15 EUR a day for 31 GB) while it is
off, until it is retrieved or deleted. Hunt records
when its agent last worked (a prompt it sent, a turn that ended, or the relay's last turn when it connects) and, once
that is seven days ago, asks in the main window whether to retrieve or delete it
(`apps/client/src/sessions/StaleRemoteDialog.tsx`); "Later" asks again three days later. A session VM is suspended by
the gateway after 30 minutes without a running turn, client activity, terminal input or `hunt-ctl` run: its idle check
(`apps/session/vm/hunt-idle-check`, every minute through `hunt-idle.timer`) decides and the gateway's sweeper (above)
asks it and suspends; a preview page view or a request other than GET counts too, for at most two hours after the agent
last worked. Services, dev servers and containers left running do not count. A VM cannot suspend itself, so when the
gateway has not suspended it 15 minutes after it first reported idle (`SUSPEND_WAIT_MINUTES` in `/etc/hunt/idle.conf`),
it powers itself off as a fallback. A suspended VM keeps its memory: the next prompt or preview page resumes it within
seconds, with its services, dev servers and containers as they were, and a resumed VM gets the same 15-minute grace as
a booted one (the check sees a resume as a gap between two of its runs). After a poweroff the disk keeps everything: the
next prompt or preview page starts the VM again, the services that were started come back by themselves, and the agent
restarts other dev servers and containers when its task needs them.

Logs: `hunt-ctl` runs over SSH outside systemd and logs its steps to the journal under the identifier `hunt-ctl`
(`journalctl -t hunt-ctl` on the VM): every command's start, its end with the duration, a failure with the exit status,
the functions and lines it failed in and the last 20 lines of its stderr, and the main steps of `install`,
`install-tools`, `stage-session`, `init`, `clone`, `prepare`, `deps` and `start`. The lines name the session ID,
repository, branch and release, never what arrives on stdin; the stderr lines have the tokens of the run and well-known
token formats replaced by `[redacted]`. `status`, `preview-status` and `service status`, which Hunt and the agent poll,
log only their failures. The services of `hunt.json` write their output to `/home/agent/logs/<name>.log`. The
Hunt units set `SyslogIdentifier` to their own name, so no log line repeats it. The infrastructure repository ships the
journal of the Hunt services to Cloud Logging with that identifier as the label `service`, where the steps of a handoff
show up with `labels.service="hunt-ctl" AND labels."compute.googleapis.com/resource_name"="vm-hunt-s-<short id>"`.

&nbsp;

### 📁 Project layout

The repository is an [Nx](https://nx.dev) workspace: every project has its own `project.json`, and builds write to
`dist/apps/<project>`.

| Path | Owns |
| --- | --- |
| `apps/client/` | Nx project `client`: the desktop app, with the Rust shell in `src-tauri/`, the React UI in `src/`, one HTML page per window and the system-prompt parts and prompts in `prompts/` |
| `apps/client/src-tauri/src/acp/` | Agent process per session, ACP event forwarding |
| `apps/client/src-tauri/src/git.rs` | Worktrees, changelists, shelve, revert, commit, push and the commit log |
| `apps/client/src-tauri/src/github.rs` | Pull requests through `gh` |
| `apps/client/src-tauri/src/session/` | Session commands, store, attribution, summaries, reviews |
| `apps/client/src-tauri/src/lsp.rs` | One `tsgo --lsp` process per worktree |
| `apps/client/src-tauri/src/workspace.rs` | Project tree and file access |
| `apps/client/src-tauri/src/graph.rs` | Architecture diagram prompts, files and status |
| `apps/client/src-tauri/src/remote/` | Session VMs, SSH to them, handoff and retrieval of remote sessions, previews, terminals |
| `apps/client/src/ipc/` | Every Tauri command, event and shared type |
| `apps/client/src/state/` | Zustand stores and chat reducers |
| `apps/client/src/` `chat/`, `diff/`, `git/`, `ide/`, `graph/`, `guardrails/`, `preview/`, `review/`, `sessions/`, `settings/`, `terminal/` | One folder per tab or window |
| `apps/client/src/ui/` | Primitives shared by every feature |
| `apps/gateway/` | Nx project `gateway`: the gateway VM's API (`src/api.ts`, `src/orchestrator.ts`, `vm/hunt-api`), issue poller (`src/swf.ts`, its prompts in `prompts/`), wake service (`src/wake.ts`) and systemd units (`vm/systemd/`) |
| `apps/session/` | Nx project `session`: the relay (`src/relay/`), the `hunt.json` services contract (`src/config.ts`), the versions of the agent's tools and the session VM's files and systemd units (`vm/`) |
| `libs/domain/` | Nx project `domain`: JSON-RPC and NDJSON framing, error messages and the system-prompt parts of remote sessions the apps share |
| `libs/vm/` | Nx project `vm`: `hunt-ctl`, which Hunt and the gateway run on the VMs |
| `scripts/` | Nx project `scripts`: the build of the VM release artifacts (`buildVmArtifact.ts`) |
| `docs/adr/` | Architectural decision records |

&nbsp;

### 🧠 Architectural decisions

Decisions that shape the codebase are recorded in [`docs/adr/`](docs/adr), one file per decision with Context,
Decision and Consequences. Read them before changing the parts they cover.

&nbsp;

### 📜 License

Hunt is released under the [MIT License](LICENSE).

The file icons in `apps/client/src/diff/atomIcons/` are the [Atom Material
Icons](https://github.com/mallowigi/iconGenerator) in pastel colors (MIT, see the `LICENSE` file in that folder).
Release bundles ship the Claude Agent SDK and the ACP adapter from npm under their own terms:
`@anthropic-ai/claude-agent-sdk` is © Anthropic PBC and governed by the [Claude Code legal
agreements](https://code.claude.com/docs/en/legal-and-compliance); `@agentclientprotocol/*` is Apache-2.0; `zod` is MIT;
`diff` is BSD-3-Clause. Using Hunt requires a Claude account whose terms apply to the agent.

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
