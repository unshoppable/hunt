# 0001 — Technical identifiers carry the name Hunt

## Date

2026-10-11

## Context

The application started under the working title "harness" and was renamed Hunt. The rename reached prose, prompts
and comments only; every technical identifier kept the old name: the diagram folder `.harness/` in each worktree and
its entry in `info/exclude`, the branch prefix `harness/`, the event field `harness_session_id`, the `_meta.harness`
marker of turns Hunt sends itself, the localStorage keys (`harness-settings`, `harness-agent-defaults`,
`harness-folder-colors`, `harness-window-bounds`, `harness.lastRepoPath`, the pane layouts), CSS classes and Monaco
ids, the store hook `useHarnessStore`, and the bundle identifier `info.medconomy.harness`.

Most of these names live in data that outlives a build: worktrees and repositories of existing sessions, the
localStorage of every window, and the app data directory the bundle identifier selects.

## Decision

Everything but the bundle identifier is renamed to Hunt, with a migration for every name stored outside the build:

- The diagram folder is `.hunt/`. `graph::watch` renames an existing `.harness/` folder when a session starts, and
  `git::exclude_hunt_dir` runs on every session start (not only on creation), replacing a `.harness/` entry in
  `info/exclude` with `.hunt/`.
- New sessions branch from `hunt/<slug>-<id>`. Existing `harness/…` branches keep their name; the session record
  stores the branch, so nothing depends on the prefix.
- Events carry `hunt_session_id` / `huntSessionId`; hidden turns carry `_meta.hunt`. The chat reducer still reads
  `_meta.harness`, because transcripts of older sessions replay it.
- `src/state/legacyStorage.ts` moves every localStorage entry whose key contains `harness` to the `hunt` name. Every
  window imports it as its first module, ahead of the stores that hydrate from localStorage.
- CSS classes, Monaco theme, action and widget ids, pane group ids, temp directories and the store hook
  (`useHuntStore`) are renamed without migration; they are not stored anywhere.
- The bundle identifier stays `info.medconomy.harness`. It selects the app data directory holding `sessions.json` and
  all worktrees; changing it would need a data migration and a re-signed bundle, which this decision does not cover.

## Consequences

- Sessions created before the rename keep working: their diagram folder is moved on the next start, their exclude
  entry is renewed, and their settings and layouts survive through the storage migration.
- Branches of older sessions still read `harness/…` on remotes and in the sidebar until the session is deleted.
- The `harness` fallbacks (`_meta.harness` in the chat reducer, `.harness/` in `graph::watch` and
  `git::exclude_hunt_dir`, the storage rename) are the only places where the old name remains in code; they can be
  removed once no session from before the rename exists.
- A future change of the bundle identifier needs its own decision and a migration of the app data directory.
