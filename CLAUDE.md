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
- `npm run check` runs `typecheck`, `lint`, `test` and `test-rust` of every project; `build:all`, `typecheck:all`,
  `lint:all` and `test:all` run one kind. `npx nx affected -t <targets>` runs them for the projects a change touches,
  `npx nx run <project>:<target>` for one.
- Targets: `typecheck` (strict tsc), `lint` and `test` (vitest per project, no root config; the client's tests are pure
  logic in the node environment); `build` for `client`, `gateway` and `session`; the client adds `dev`, `bundle`
  (`tauri build`) and `test-rust` (`cargo test` in `apps/client/src-tauri`). The session's `test` runs its `build`
  first, and so does the gateway's: their Docker tests of `hunt-ctl` use the built artifact. `cargo build` must stay
  free of warnings.
- There is no formatter; never run prettier or `cargo fmt`. Format by hand: TypeScript up to ~160 columns, Rust per
  `apps/client/src-tauri/rustfmt.toml`.

## Layout

- Projects: `client` (`apps/client`, the desktop app), `gateway` (`apps/gateway`, issue poller and wake service of the
  gateway VM), `session` (`apps/session`, relay, `hunt.json` config and VM files of a session VM), `domain`
  (`libs/domain`, code, agent prompts and the protocol number the apps share), `vm` (`libs/vm`, `hunt-ctl`) and
  `scripts` (`scripts/`, the VM artifact build). Builds write to `dist/apps/<project>`. Paths and project names carry
  no `hunt` segment or prefix.
- TypeScript 6 defaults `types` to `[]`: Node scripts under `scripts/` typecheck through `tsconfig.scripts.json`
  (`types: ["node"]`); never add `node` types to a browser config, it turns `setTimeout` into `NodeJS.Timeout`.
- Paths starting with `src/` or `src-tauri/` and the window pages are relative to `apps/client/`; bare module paths
  such as `ide/paneGrid.ts` or `session/commands.rs` to its `src/` or `src-tauri/src/`.
- `src/ipc` wraps every Tauri command (`commands.ts`), event (`events.ts`) and shared type (`types.ts`); `invoke`
  and `listen` are never called elsewhere. `src/state` holds the zustand stores. `src/ui` holds primitives shared by
  every feature. Feature folders (`chat`, `diff`, `ide`, `graph`, `guardrails`, `sessions`, `settings`) map 1:1 to
  tabs and windows; `src/diff/monaco.ts`, `styles.ts` and `fileIcons.ts` are the shared Monaco and icon layer and
  may be imported by any feature.
- Every native window is a root HTML page (`index.html`, `editor.html`, `diff.html`, `guardrails.html`,
  `settings.html`) with a 10-line bootstrap in `src/<name>.tsx` and a `<Name>Window.tsx` in its feature folder;
  windows are created only through `openOrFocusWindow` (or `createWindow` after an explicit existence check) in
  `src/ui/nativeWindow.ts`.
- Pure logic lives in a `.ts` module with a sibling `.test.ts` next to the component or store that uses it
  (`ide/paneGrid.ts`, `diff/lineDiff.ts`, `ide/lsp/protocol.ts`, `graph/schema.ts`, `state/store.ts` reducers).
- Prompt files live in a `prompts/` folder of the project that sends them (`libs/domain/prompts/` for the parts the
  app and the poller share) and carry their role as suffix: `<name>.system-prompt.md` extends Claude Code's system
  prompt, `<name>.user-prompt.md` is a message Hunt sends into the chat, with `{{name}}` placeholders that code fills
  (`fillPrompt` in `libs/domain/src/prompts.ts`). Code never holds prompt text, and a prompt file holds nothing but
  its prompt: the `README.md` of each `prompts/` folder says who sends which file, when and where it lands.
- Server code (`apps/gateway`, `apps/session`, `libs/domain`) must stay runnable on plain Node, since tests start it
  through type stripping: `erasableSyntaxOnly`, `.ts` extensions in relative imports, and no runtime package but
  Node's built-ins (the artifact build rejects any other). It imports `libs/domain` by relative path
  (`../../../libs/domain/src/…`), which Nx sees through `pluginsConfig.@nx/js.analyzeSourceFiles`.
  `scripts/buildVmArtifact.ts` bundles each entry point into one `.mjs` with esbuild and lays the artifact out as
  `/srv/hunt/current` expects (`gateway/`, `relay/`, `session/`, `vm/`). The client never installs a release: after
  a release CI deploys both apps onto the gateway over SSH (`hunt-ctl install`, `hunt-ctl stage-session`), and the
  gateway installs the staged session release on session VMs; the client only checks `libs/domain/protocol.json`,
  which must change whenever `hunt-ctl`'s or the relay's contract changes incompatibly, and has session VMs install
  the agent tools their image lacks (`hunt-ctl install-tools`). The client controls VMs only through the gateway API
  (`libs/domain/src/gatewayApi.ts`, `api` in `protocol.json`).

## Frontend rules

- **Dismissal and keyboard phases.** Anchored popovers and menus use `useDismiss` (`src/ui/useDismiss.ts`), modal
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
- **Shortcuts**: every app-level shortcut is a `KEYMAP_COMMANDS` entry (`src/state/keymap.ts`), matched with
  `isShortcut`/`shortcutCommand` (`src/ui/shortcuts.ts`) or `onShortcut` in Monaco and labelled with
  `useShortcutLabel`; never test `metaKey`/`key` for one. Fixed in-dialog keys (Enter, ⌘Enter, ⌥ toggles, an Escape
  that closes) stay out of the keymap.
- **Trees** navigate with the arrow keys through `useTreeNavigation` (`src/ui/useTreeNavigation.ts`) and open and
  close folders through `toggleInExpanded`/`toggleInCollapsed` (`src/ui/treeExpansion.ts`), so closing a folder closes
  its subfolders. The project tree's selection follows clicks and ⇧⌘2 only, never the active editor tab.
- **Floating surfaces** (dialogs and popovers, not context menus) are resizable and remember their size: a `PopupKey`
  with a default in `DEFAULT_POPUP_SIZES` (`src/state/settings.ts`), `useDialogSize` for a `Modal`, `usePopupSize`
  with `<ResizeGrips>` as a direct child of a popover's root; no fixed `w-[…]`.
- **Agent state** shows only busy or idle, plus `SessionMark`'s question and unseen badges; never whether the agent
  process runs (`isLive`).
- **Window permissions**: every mutating window call (`close`, `setTitle`, `setSize`, `show`, `setFocus`, …) needs its
  own `core:window:allow-<name>` in `src-tauri/capabilities/default.json` (`core:window:default` grants only getters),
  and a new window label must match its `windows` list. A denied call rejects, which `void` swallows.
- **Language servers**: never block a UI result on the Angular language server (seconds per newly loaded project);
  show tsgo's answer first and complete it later, as `findUsages` does with `isComplete`.
- **Async loads** use `useLoad` (`src/ui/useLoad.ts`); never hand-roll `let isCurrent = true`. Long-running
  invalidation uses a generation counter as in `ide/changeMarkers.ts`.
- **Confirmations** go through `confirmDestructive` (`src/ui/confirm.ts`). `window.confirm`, `prompt` and `alert`
  are no-ops in the Tauri webview and `!somePromise` type-checks, so a sync-looking call is a silent bug.
- **Paths**: `baseName`, `dirName`, `splitPath` from `src/ui/path.ts`; no inline `split("/")`.
- **Monaco**: previews start from `PREVIEW_EDITOR_OPTIONS`, editors from `EDITOR_APPEARANCE_OPTIONS`
  (`src/diff/monaco.ts`). Every Monaco host reads font size, family and line height from the pane settings
  (`useSettingsStore((state) => state.panes.diff.…)`, `panes.editor` in `ide/EditorPane`); a new setting must reach every host: `diff/DiffPanel`,
  `diff/CodeDiffEditor` and `SplitDiffView`/`splitDiff.ts`, `graph/DiffWindow`,
  `ide/EditorPane`, `ide/FileSearchDialog`, `ide/UsagesPopover`, `guardrails/GuardrailsWindow`.
- **Settings**: a new field goes into the state type, `DEFAULT_*`, the action, `partialize` and, when the shape
  changes, a `version` bump with a `migrate` step in `src/state/settings.ts`; `SECTIONS` and `FIELD_LABELS` in
  `SettingsWindow.tsx` render it. Cross-window sync is automatic via `settings:changed`.
- **Stores**: subscribe with selectors; `getState()` only inside event handlers. Chat state changes only through
  the reducers in `state/store.ts`.
- Fire-and-forget calls are `void promise` and the action itself must report failure into state (`chat.error`,
  a local `error`), not swallow it.

## Backend rules

- Tauri commands are thin: look the session up, validate, delegate to a domain module (`git.rs`, `workspace.rs`,
  `ide.rs`, `lsp.rs`), which knows nothing about Tauri. `session/commands.rs` owns the session commands;
  `lsp.rs` and `preferences.rs` own their own thin commands.
- **Paths from the frontend** are worktree-relative and are resolved only through `session_file` in
  `session/commands.rs`, which calls `git::ensure_inside_worktree`. Git refs and paths go after `--`.
- Errors are `Result<_, String>` with the message `failed to <verb> <what>: {error}`; nothing panics in production
  code except lock poisoning.
- `std::sync::Mutex` only when the guard is never held across an `.await`; otherwise `tokio::sync::Mutex`.
  Tauri-aware modules spawn with `tauri::async_runtime::spawn`; the Tauri-free LSP core uses `tokio::spawn`.
- Background work that must not fail a command follows `session/summary.rs` and `session/attribution.rs`:
  spawn, serialize per key, `eprintln!` on failure.
- `sessions.json` is written only through `session/store.rs` (temp file + rename, under `STORE_LOCK`); a new
  persisted field gets `#[serde(default)]`, a place in `SessionRecord::new`, and a mirror in `src/ipc/types.ts`.
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

1. Command fn in the owning Rust module, registered in the `generate_handler!` list in `src-tauri/src/lib.rs`
   (forgetting this fails only at runtime with "command not found").
2. Wrapper in `src/ipc/commands.ts` (TS camelCase arguments map to Rust snake_case) and types in `src/ipc/types.ts`
   mirroring the `#[serde(rename_all = "camelCase")]` struct.
3. For an event: `emit` in Rust, the payload in `EventPayloads` (`src/ipc/events.ts`), wiring in
   `src/app/bootstrap.ts`.

## Style

- Loops and non-guard bodies always use braces; a guard clause whose body is a single `return`/`continue`/`break`/
  `throw` stays on one line.
- Comments describe what the code does or a constraint it cannot show, never the change that was made.
- Named exports only; components are PascalCase `.tsx`, modules camelCase `.ts`. A module's name never differs from
  a component's only in case (`refTree.ts` beside `RefTree.tsx`): macOS file systems are case-insensitive.
- The product is "Hunt" in every user-facing string, prompt and doc; identifiers are `hunt` (`.hunt/`, `hunt-*` keys
  and CSS classes, `useHuntStore`). Remaining `harness` strings are migrations (`legacy_identifier.rs`).
- Prefer a plain truthiness check over `isUndefined`/`isNull` unless a falsy value is legitimate.
- Commit messages follow Conventional Commits (`type(scope): description`). `feat`, `fix`, `perf`, `revert` and a
  `!`/`BREAKING CHANGE` footer decide the next release version of every app the commit touches (`nx release`,
  independent versions); other types do not release. Pull requests are squash-merged with their title as commit
  message, so the PR title is what `nx release` reads; `ci-pull-request.yml` checks it. Branch names follow
  `feat|feature|fix|chore/<scope>/<name>` (e.g. `feat/general/abc`), checked by the pre-push hook (`.husky/`) and CI.
