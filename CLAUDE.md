# Hunt — conventions for contributors and coding agents

Desktop client for Claude Code: Tauri 2 (Rust, `apps/client/src-tauri/`) shell, React 19 UI (`apps/client/src/`),
plus the Node services that run remote sessions on GCP VMs. README.md explains what each subsystem does and which file
owns it; this file says how code here is written and verified. Rules for only part of the code live in
`.claude/rules/*.md` with `paths:` front matter (`ui.md`, `webview-gotchas.md`, `verifying-ui.md` for the client);
everything else goes here.

## Commands

- Nx 23 workspace: an explicit `project.json` per project, no inference plugins, no npm workspaces. Node and npm are
  pinned through Volta in the root `package.json`.
- `npm run start:client` runs the app (`nx run client:dev`: `tauri dev`, whose `beforeDevCommand` starts Vite);
  `npm run tauri -- <args>` runs the Tauri CLI in `apps/client`.
- `npm run check` runs `lint`, `test` and `test-rust` of every project; `build:all`, `lint:all` and `test:all` run
  one kind. `npx nx affected -t <targets>` runs them for the projects a change touches,
  `npx nx run <project>:<target>` for one.
- Targets: `typecheck-tests` (strict `tsc --noEmit` of the project's tsconfig, tests included), which each `test`
  lists in `dependsOn` in its `project.json`, so nothing calls it alone; the tests of `gateway` and `session` also run
  the one of `scripts`, which has no tests. Builds (Vite, esbuild) do not type-check. `lint` and `test` (vitest per
  project, no root config; vitest only transpiles; the client's tests are pure logic in the node environment); `build`
  for `client`, `gateway` and `session`; the client adds `dev`, `bundle` (`tauri build`) and `test-rust` (`cargo test`
  in `apps/client/src-tauri`). The session's `test` runs its `build` first, and so does the gateway's: their Docker
  tests of `hunt-ctl` use the built artifact. `cargo build` must stay free of warnings.
- `client:tmux` (`scripts/buildTmux.ts`) builds the static tmux Hunt bundles into `apps/client/src-tauri/binaries/`
  (git-ignored, cached by Nx and CI); the client's `dev`, `bundle` and `test-rust` depend on it, and likewise on
  `client:review-widget` (`scripts/buildReviewWidget.ts`), which builds the review widget into
  `apps/client/src-tauri/resources/review.js` for `agent/browser.rs`. A plain `cargo build` needs both run first.
- There is no formatter; never run prettier or `cargo fmt`. Format by hand: TypeScript up to ~160 columns, Rust per
  `apps/client/src-tauri/rustfmt.toml`.

## Layout

- Projects: `client` (`apps/client`, the desktop app), `gateway` (`apps/gateway`, issue poller and wake service of the
  gateway VM), `session` (`apps/session`, relay, `hunt.json` config and VM files of a session VM), `domain`
  (`libs/domain`, the concepts the apps share, agent prompts and the protocol number), `vm` (`libs/vm`, `hunt-ctl`) and
  `scripts` (`scripts/`, the VM artifact build). Builds write to `dist/apps/<project>`. Paths and project names carry
  no `hunt` segment or prefix.
- Code is organised by domain concept, not by technical layer: a folder (slice) per concept, its files named
  `<concept>.<kind>.ts` after what they hold. Kinds: `value-object` (a concept with rules, identity-free, compared by
  value), `domain` (an aggregate with a lifecycle and intent methods), `service` (orchestration with I/O dependencies:
  load → intent → respond, no business rules), `client` (access to GitHub, Compute Engine, SSH or a socket), `utils`
  (logic no value object or model owns), `types`, `rules` (named zod scalar rules several value objects share), `error`
  (an Error subclass a boundary reports), `main` (an entry point with its CLI guard), `fixtures` (test-only builders
  several test files share; only tests import them). A slice's public surface is its `service`, `domain`,
  `value-object` and `client` files; `utils`, `main` and server `types` files are internal. That holds for the slices
  of the apps only: `libs/domain/src/**/*.utils.ts` and `*.types.ts` are public to every app, since a shared library
  has no slice-internal files. No barrel `index.ts`. Tests are vitest siblings (`<name>.test.ts`).
- Value objects and domain models extend the base classes in `libs/domain/src/model/`: the class declares its zod
  schema as `static readonly schema`, the constructor parses the state, the attributes are proxied onto the instance
  (`export interface X extends z.infer<typeof ZodXState> {}` beside `export class X`), derived values are getters.
  A domain model changes its state only inside `changeState(() => { … })`, which re-parses the schema and rolls back
  when it rejects (Hunt has no decorators: Node's type stripping cannot run them). Concepts several apps share live in
  `libs/domain/src/<concept>/`; a domain model lives in the slice that owns its lifecycle.
- TypeScript 6 defaults `types` to `[]`: Node scripts under `scripts/` are type-checked through `tsconfig.scripts.json`
  (`types: ["node"]`); never add `node` types to a browser config, it turns `setTimeout` into `NodeJS.Timeout`.
- Paths starting with `src/` or `src-tauri/` and the window pages are relative to `apps/client/`; bare module paths
  such as `ide/pane-layout.value-object.ts` or `session/commands/mod.rs` to its `src/` or `src-tauri/src/`.
- `src/ipc` wraps every Tauri command (`commands.ts`) and event (`events.ts`); `invoke` and `listen` are never called
  elsewhere. The types they carry mirror the Rust structs and live in the `*.types.ts` of the feature that owns the
  concept (`sessions/session.types.ts`, `git/git.types.ts`, …), which `src/ipc` imports with `import type`; a type
  shared by features that may not import each other goes to the lower one or to `src/common/<purpose>/<name>.types.ts`.
  Each feature folder holds its zustand stores (`*.store.ts`). `src/ui` holds primitives shared by every feature,
  `src/common` logic and types several features share (paths, globs, trees, the keymap, changed files, diagram types,
  relative times), `src/editor` the Monaco layer. Feature folders (`chat`, `diff`, `ide`, `graph`, `guardrails`,
  `sessions`, `settings`) map 1:1 to tabs and windows.
- Imports point down: `common` ← `ipc` ← `ui` + `settings/settings.store.ts`/`settings.types.ts` ← `editor` ←
  `accounts` ← `sessions` ⇄ `chat` (one aggregate) ← other features ← `popup` + `control` ← `app` ← `windows`; `src/ipc` and
  `ui/popup-protocol.utils.ts` import feature types type-only. Sideways, and up from the aggregate, only
  checks→preview/terminal, diff→ide/review, git→diff/ide, graph→ide/review, guardrails→ide, ide→review/terminal,
  terminal→diff/preview, sessions→git/ide; two-way folder pairs (no module cycles): chat ⇄ guardrails, chat ⇄ ide,
  diff ⇄ graph, editor ⇄ ide.
- Every native window is a root HTML page (`index.html`, `editor.html`, `diff.html`, `guardrails.html`,
  `settings.html`, `popup.html`) with a bootstrap in `src/windows/<name>.tsx` whose root component calls the hooks of
  `app/window-bootstrap.hook.ts` the window needs and renders its `<Name>Window.tsx` from the feature folder
  (`popup/PopupWindow.tsx` for every detachable popup; `app/App.tsx` calls the main window's hooks itself); windows are
  created only through `openOrFocusWindow` (or `createWindow` after an explicit existence check) in
  `src/ui/native-window.utils.ts`, popup windows only through `useDetachedPopup` (`src/ui/detached-popup.hook.ts`).
- Pure logic lives in a `.ts` module with a sibling `.test.ts` next to the component or store that uses it
  (`editor/line-diff.utils.ts`, `ide/lsp/lsp-protocol.utils.ts`, `graph/schema.utils.ts`, `chat/chat-reducer.utils.ts`).
- Prompt files live in a `prompts/` folder of the project that sends them (`libs/domain/prompts/` for the parts the
  app and the poller share; the gateway's is `apps/gateway/software-factory/`, the steps of the swf pipeline numbered in
  their order) and carry their role as suffix: `<name>.system-prompt.md` extends Claude Code's system
  prompt, `<name>.user-prompt.md` is a message Hunt sends into the chat, with `{{name}}` placeholders that code fills
  (`fillPrompt` in `libs/domain/src/shared/prompts.utils.ts`). Code never holds prompt text, and a prompt file holds nothing but
  its prompt: the `README.md` of each prompt folder says who sends which file, when and where it lands.
- Server code (`apps/gateway`, `apps/session`, `libs/domain`) must stay runnable on plain Node, since tests start it
  through type stripping: `erasableSyntaxOnly`, `.ts` extensions in relative imports, and no runtime package but
  Node's built-ins and the few the artifact build bundles (`BUNDLED_PACKAGES` in `scripts/buildVmArtifact.ts`: zod;
  the build rejects any other). zod is imported as `import * as z from "zod/mini"` everywhere (ESLint enforces it):
  that form tree-shakes to ~30 KB per bundle; the classic API, and the named `{ z }` of zod/mini, add ~700 KB. It imports `libs/domain` by relative path
  (`../../../libs/domain/src/…`), which Nx sees through `pluginsConfig.@nx/js.analyzeSourceFiles`.
  `scripts/buildVmArtifact.ts` bundles each entry point into one `.mjs` with esbuild and lays the artifact out as
  `/srv/hunt/current` expects (`gateway/`, `relay/`, `session/`, `vm/`). The client never installs a release: after
  a release CI deploys both apps onto the gateway over SSH (`hunt-ctl install`, `hunt-ctl stage-session`), and the
  gateway installs the staged session release on session VMs; the client only checks `libs/domain/protocol.json`,
  which must change whenever `hunt-ctl`'s or the relay's contract changes incompatibly, and has session VMs install
  the agent tools their image lacks (`hunt-ctl install-tools`). The client controls VMs only through the gateway API
  (`libs/domain/src/gateway-api/gateway-api.types.ts`, `api` in `protocol.json`).

## Frontend rules

- **Dismissal and keyboard phases.** Anchored popovers and menus use `useDismiss` (`src/ui/dismiss.hook.ts`), modal
  dialogs use `Modal` (`src/ui/Modal.tsx`); both take Escape in the capture phase and stop it. Window-wide shortcuts
  (`ChatPanel` Escape cancelling a turn, `useSecondaryWindow` Escape/⌘W) listen in the bubble phase; ⌘W respects
  `defaultPrevented`, but for Escape only a stopped propagation counts as taken, because a focused Monaco editor calls
  `preventDefault` on every Escape. So Escape closes every floating surface and secondary window, also from inside an
  editor; never add a "window ignores Escape while X" flag, whatever needs Escape takes it in the capture phase and
  stops it. Only `ChatPanel` interrupts a turn with Escape; composers have no stop button (`SEND_BUTTON` queues while a
  turn runs). The one capture-phase exception is `IdePanel`'s ⌘-shortcuts, so that they win over Monaco's own
  bindings. Never add a bubble-phase Escape listener to something that floats, and never handle arrow or Enter keys on
  `window`; put them on the focused element. Events sent to one window (`emitTo(label, …)`) are received through
  `listenTo(name, handler, { target: label })`, otherwise every window gets them.
- **Shortcuts**: every app-level shortcut is a `KEYMAP_COMMANDS` entry (`src/common/keymap/keymap-commands.data.ts`), matched with
  `isShortcut`/`shortcutCommand` (`src/ui/shortcuts.utils.ts`) or `onShortcut` in Monaco and labelled with
  `useShortcutLabel` (`src/ui/shortcut-label.hook.ts`); never test `metaKey`/`key` for one. Fixed in-dialog keys
  (Enter, ⌘Enter, ⌥ toggles, an Escape that closes) stay out of the keymap.
- **Trees** navigate with the arrow keys through `useTreeNavigation` (`src/ui/tree-navigation.hook.ts`) and open and
  close folders through `toggleInExpanded`/`toggleInCollapsed` (`src/common/tree/tree-expansion.utils.ts`), so closing a folder closes
  its subfolders. The project tree's selection follows clicks and ⇧⌘2 only, never the active editor tab.
- **Floating surfaces** (dialogs and popovers, not context menus) are resizable and remember their size: a `PopupKey`
  with a default in `DEFAULT_POPUP_SIZES` (`src/settings/settings.store.ts`), `useDialogSize` for a `Modal`, `usePopupSize`
  with `<ResizeGrips>` as a direct child of a popover's root; no fixed `w-[…]`.
- **Detachable popups** (`DetachablePopupKey` in `src/settings/settings.store.ts`) show in a native window of their own or in
  the app window, as `detachedPopups` says. Each splits into a view with `isDetached`, the in-app frame (Modal or
  popover, closed by Escape and a click outside) and a host-side `Detached…` that calls `useDetachedPopup`
  (`src/ui/detached-popup.hook.ts`); the window (`popup/PopupWindow.tsx`) gets plain data (`PopupContents` in
  `ui/popup-protocol.utils.ts`) and sends `PopupActions` back, since it has stores of its own. A popup window closes
  only on its own Escape, ⌘W and traffic light: navigating from it keeps it open, finishing buttons (Attach, Refactor,
  Decline) close it. In a window the view must not stop `mousedown` propagation (Tauri's drag region listens on
  `document`) nor add window-wide Escape or click-outside listeners. Both title rows carry `PopupModeButton`.
- **Agent state** shows only busy or idle, plus `SessionMark`'s question and unseen badges; never whether the agent
  process runs (`isLive`).
- **Window permissions**: every mutating window call (`close`, `setTitle`, `setSize`, `show`, `setFocus`, …) needs its
  own `core:window:allow-<name>` in `src-tauri/capabilities/default.json` (`core:window:default` grants only getters),
  and a new window label must match its `windows` list. A denied call rejects, which `void` swallows.
- **Language servers**: never block a UI result on the Angular language server (seconds per newly loaded project);
  show tsgo's answer first and complete it later, as `findUsages` does with `isComplete`.
- **Async loads** use `useLoad` (`src/ui/load.hook.ts`); never hand-roll `let isCurrent = true`. Long-running
  invalidation uses a generation counter as in `ide/change-markers.monaco.ts`.
- **Confirmations** go through `confirmDestructive` (`src/ui/confirm.utils.ts`). `window.confirm`, `prompt` and `alert`
  are no-ops in the Tauri webview and `!somePromise` type-checks, so a sync-looking call is a silent bug.
- **Paths**: `baseName`, `dirName`, `splitPath` from `src/common/path/path.utils.ts`; no inline `split("/")`.
- **Monaco**: previews start from `PREVIEW_EDITOR_OPTIONS`, editors from `EDITOR_APPEARANCE_OPTIONS`
  (`src/editor/monaco.constants.ts`). Every Monaco host reads font size, family and line height from the pane settings
  (`useSettingsStore((state) => state.panes.diff.…)`, `panes.editor` in `ide/EditorPane`); a new setting must reach every host: `diff/DiffPanel`,
  `diff/CodeDiffEditor` and `SplitDiffView`/`split-diff.monaco.ts`, `diff/DiffWindow`,
  `ide/EditorPane`, `ide/search/FileSearchDialog`, `ide/language/UsagesPopover`, `guardrails/markdown-monaco.hook.ts`.
- **Settings**: a new field goes into the state type, `DEFAULT_*`, the action, `partialize` and, when the shape
  changes, a `version` bump with a `migrate` step in `src/settings/settings.store.ts`; `SECTIONS` and `FIELD_LABELS` in
  `src/settings/pane-sections.data.ts` render it. Cross-window sync is automatic via `settings:changed`.
- **Stores**: subscribe with selectors; `getState()` only inside event handlers. Chat state changes only through
  the Hunt store (`sessions/hunt.store.ts`, composed of the session, remote session and chat slices) and the reducers in
  `chat/chat-reducer.utils.ts`.
- Fire-and-forget calls are `void promise` and the action itself must report failure into state (`chat.error`,
  a local `error`), not swallow it.

## Backend rules

- Tauri commands are thin: look the session up, validate, delegate to a domain module (`git/git.rs`,
  `ide/workspace.rs`, `ide/webstorm.rs`, `ide/lsp.rs`), which knows nothing about Tauri. `session/commands/` owns the
  session commands, one file per concern; `ide/lsp.rs` and `platform/preferences.rs` own their own thin commands.
- **Paths from the frontend** are worktree-relative and are resolved only through `session_file` in
  `session/commands/mod.rs`, which calls `git::ensure_inside_worktree`. Git refs and paths go after `--`.
- Errors are `Result<_, String>` with the message `failed to <verb> <what>: {error}`; nothing panics in production
  code except lock poisoning.
- `std::sync::Mutex` only when the guard is never held across an `.await`; otherwise `tokio::sync::Mutex`.
  Tauri-aware modules spawn with `tauri::async_runtime::spawn`; the Tauri-free LSP core uses `tokio::spawn`.
- Background work that must not fail a command follows `session/summary.rs` and `session/attribution.rs`:
  spawn, serialize per key, `eprintln!` on failure.
- Every tmux call on this Mac goes through the worktree's `.hunt/tmux` (`terminal/tmux.rs`: the bundled binary, the family's
  socket and `.hunt/tmux.conf`, whose hooks log every window to `.hunt/logs/desktop/`); never a `tmux` from `PATH`.
  A session VM's system tmux reads `/etc/tmux.conf` (`apps/session/vm/tmux.conf`) with the same hooks; change both
  together. Hunt never pipes a window to its log itself: the hooks do, also after any `pipe-pane`, since `-o` closes an
  open pipe. tmux runs a pipe's command through `strftime`, so it holds no unescaped `%`. Every window on this Mac names
  its Hunt session in `@hunt-session`: code that creates a window sets it, and `.hunt/tmux` does for an agent's windows
  through `HUNT_SESSION_ID`.
- `sessions.json` is written only through `session/store.rs` (temp file + rename, under `STORE_LOCK`, which holds only
  within the app: the `hunt` command line in `src-tauri/src/cli/` reads it with `store::read_sessions`, never writes); a new
  persisted field gets `#[serde(default)]`, a place in `SessionRecord::new`, and a mirror in
  `src/sessions/session.types.ts`.
- Hunt's own agent jobs (diagram generation and the like) each run as a separate headless `claude -p` as in
  `session/diagram_agent.rs`, with `--permission-mode dontAsk` and an explicit `--allowedTools`; never as a turn of
  the session's chat agent, and never waiting for it to be idle.

## Remote sessions

- Solve preview, routing and auth problems of remote sessions in Hunt or in the infrastructure repository, never by
  changing the previewed app; configuration the app already reads (env vars, build-time globals such as
  `DEV_BACKEND_ORIGIN`) is fine.
- Hunt carries what a session needs (private files, secrets, tokens) itself: fix the path from the main checkout to
  the worktree and the VM instead of documenting a command people run by hand.
- Commit, push, rebase and the push target of a remote session never wait for its VM: they work on the local worktree,
  and the VM follows at the next connect. Ask the gateway (`vms.get`) before any SSH to a VM; an IAP tunnel to a
  stopped VM fails only after 30 s.
- Never commit on the VM and never sync `.git` as files; branches meet only through the refs of `remote/commit.rs`
  (`refs/hunt/<id>/head`, `refs/hunt/<id>/local`). The changelist stays HEAD-relative.
- A remote setting that is the same for everyone (gateway, zones, template, swf repositories) lives in
  `unshoppable/infrastructure`, and Hunt discovers it; *Settings → Remote VM* holds only per-person values.
- No workflow triggered by `pull_request_target` or `workflow_run` gets `id-token: write`: its ref is master, which
  `sa-deploy-hunt` and `sa-image-hunt` trust.

## Adding an IPC command or event

1. Command fn in the owning Rust module, registered in the `command_handler!` list of `session/commands/mod.rs`, whose
   test fails while that list and the `invoke` calls of `src/ipc/commands.ts` differ.
2. Wrapper in `src/ipc/commands.ts` (TS camelCase arguments map to Rust snake_case). The mirror of the
   `#[serde(rename_all = "camelCase")]` struct goes into the `*.types.ts` of the feature that owns it, its doc comment
   naming the Rust struct; `commands.ts` imports it with `import type`.
3. For an event: `emit` in Rust, the payload type in the owning feature's `*.types.ts` and in `EventPayloads`
   (`src/ipc/events.ts`), wiring in `src/app/window-bootstrap.hook.ts`.

## Style

- Loops and non-guard bodies always use braces; a guard clause whose body is a single `return`/`continue`/`break`/
  `throw` stays on one line.
- Comments describe what the code does or a constraint it cannot show, never the change that was made.
- Named exports only; components are PascalCase `.tsx`, modules kebab-case `.ts` with their kind as suffix
  (`session-id.value-object.ts`, `swf-step.types.ts`; see Layout). A camelCase module under `apps/` predates this
  rule and is renamed when its slice is restructured. A module's name never differs from a component's only in case
  (`refTree.ts` beside `RefTree.tsx`): macOS file systems are case-insensitive.
- The product is "Hunt" in every user-facing string, prompt and doc; identifiers are `hunt` (`.hunt/`, `hunt-*` keys
  and CSS classes, `useHuntStore`). Remaining `harness` strings are migrations (`platform/legacy_identifier.rs`).
- Prefer a plain truthiness check over `isUndefined`/`isNull` unless a falsy value is legitimate.
- Commit messages follow Conventional Commits (`type(scope): description`). `feat`, `fix`, `perf`, `revert` and a
  `!`/`BREAKING CHANGE` footer decide the next release version of every app the commit touches (`nx release`,
  independent versions); other types do not release. Pull requests are squash-merged with their title as commit
  message, so the PR title is what `nx release` reads; `ci-pull-request.yml` checks it. Branch names follow
  `feat|feature|fix|chore/<scope>/<name>` (e.g. `feat/general/abc`), checked by the pre-push hook (`.husky/`) and CI.
