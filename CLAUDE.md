# Hunt — conventions for contributors and coding agents

Desktop client for Claude Code: Tauri 2 (Rust, `src-tauri/`) shell, React 19 UI (`src/`). README.md explains what
each subsystem does and which file owns it; this file says how code here is written and verified.

## Commands

- `npm run tauri dev` runs the app; `npm run check` runs everything below.
- `npm run typecheck` (strict tsc), `npm test` (vitest, node environment, pure logic only), `npm run test:rust`
  (`cargo test` in `src-tauri`). `cargo build` must stay free of warnings.
- There is no formatter. Format by hand: TypeScript up to ~160 columns, Rust per `src-tauri/rustfmt.toml`.

## Layout

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

## Frontend rules

- **Dismissal and keyboard phases.** Anchored popovers and menus use `useDismiss` (`src/ui/useDismiss.ts`), modal
  dialogs use `Modal` (`src/ui/Modal.tsx`); both take Escape in the capture phase and stop it. Window-wide shortcuts
  (`ChatPanel` Escape cancelling a turn, `useSecondaryWindow` Escape/⌘W) listen in the bubble phase and respect
  `defaultPrevented`; the one exception is `IdePanel`'s ⌘-shortcuts, which listen in the capture phase on purpose so
  that they win over Monaco's own bindings. Never add a bubble-phase Escape listener to something that floats, and
  never handle arrow or Enter keys on `window`; put them on the focused element. Events sent to one window
  (`emitTo(label, …)`) are received through `listenTo(name, handler, { target: label })`, otherwise every window
  gets them.
- **Async loads** use `useLoad` (`src/ui/useLoad.ts`); never hand-roll `let isCurrent = true`. Long-running
  invalidation uses a generation counter as in `ide/changeMarkers.ts`.
- **Confirmations** go through `confirmDestructive` (`src/ui/confirm.ts`). `window.confirm`, `prompt` and `alert`
  are no-ops in the Tauri webview and `!somePromise` type-checks, so a sync-looking call is a silent bug.
- **Paths**: `baseName`, `dirName`, `splitPath` from `src/ui/path.ts`; no inline `split("/")`.
- **Monaco**: previews start from `PREVIEW_EDITOR_OPTIONS`, editors from `EDITOR_APPEARANCE_OPTIONS`
  (`src/diff/monaco.ts`). Every Monaco host reads font size, family and line height from the pane settings
  (`useSettingsStore((state) => state.panes.diff.…)`); a new setting must reach every host: `diff/DiffPanel`,
  `diff/CodeDiffEditor` and `SplitDiffView`/`splitDiff.ts`, `graph/DiffWindow`, `ide/EditorPane`,
  `ide/FileSearchDialog`, `ide/UsagesPopover`, `guardrails/GuardrailsWindow`.
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

## Adding an IPC command or event

1. Command fn in the owning Rust module, registered in the `generate_handler!` list in `src-tauri/src/lib.rs`
   (forgetting this fails only at runtime with "command not found").
2. Wrapper in `src/ipc/commands.ts` (TS camelCase arguments map to Rust snake_case) and types in `src/ipc/types.ts`
   mirroring the `#[serde(rename_all = "camelCase")]` struct.
3. For an event: `emit` in Rust, the payload in `EventPayloads` (`src/ipc/events.ts`), wiring in
   `src/app/bootstrap.ts`.

## Architectural decisions

Architectural decisions are recorded in `docs/adr/NNNN-title.md`, one per file (Context, Decision, Consequences).
Before making or questioning an architectural decision, check for an existing one: `ls docs/adr/` lists them by
number and title, `grep -ril <topic> docs/adr/` finds those mentioning a topic (try a synonym when nothing matches).
Follow an existing decision; if a change contradicts one, say so and propose a new ADR instead of silently diverging.

## Style

- Loops and non-guard bodies always use braces; a guard clause whose body is a single `return`/`continue`/`break`/
  `throw` stays on one line.
- Comments describe what the code does or a constraint it cannot show, never the change that was made.
- Named exports only; components are PascalCase `.tsx`, modules camelCase `.ts`.
- Prefer a plain truthiness check over `isUndefined`/`isNull` unless a falsy value is legitimate.
- Commit messages follow Conventional Commits (`type(scope): description`). `feat`, `fix`, `perf`, `revert` and a
  `!`/`BREAKING CHANGE` footer decide the next release version (ADR 0003); other types do not release.
