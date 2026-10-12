# 0003 — Releases are cut by a manually started workflow

## Date

2026-10-11

## Context

ADR 0002 left four manual steps per release: bump `version` in `package.json`, `tauri.conf.json` and `Cargo.toml`
(plus the two lock files and the README badge, which drifted), push a `v*` tag, wait for the build, publish the draft.
Each step was a chance to forget one of the files or to publish a release whose assets were incomplete. Pushing a tag
is also the wrong trigger when the tag itself is something the pipeline should produce.

The only decision a human has to make is *that* a release happens now. Which version it gets follows from the kind of
changes it carries, which Conventional Commits already encode.

## Decision

- `release.yml` has a single trigger, `workflow_dispatch`, started from `master`. The tag trigger is gone; the
  workflow creates the tag.
- Commit messages follow Conventional Commits 1.0. The job `version` runs `scripts/release/release.ts`, which reads
  the commits since the last `v*` tag and bumps: `BREAKING CHANGE:` footer or `!` after type/scope → major, `feat` →
  minor, `fix`/`perf`/`revert` → patch; every other type and every non-conventional subject does not release.
  Breaking changes bump major even below 1.0. The `bump` input (`patch`/`minor`/`major`) overrides the derived type;
  the run fails when `auto` finds no releasable commit.
- The same script rewrites the version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and the README badge, refusing when a file does not hold the current
  version exactly as often as expected, and renders release notes from the parsed commits (Breaking changes,
  Features, Fixes, Performance). The workflow commits `chore(release): vX.Y.Z` as `github-actions[bot]`, tags and
  pushes with `GITHUB_TOKEN`; that push triggers nothing further.
- `build` checks out the tag and attaches the DMG and updater artifacts to a draft release as before. `publish` runs
  only when every target built and turns the draft into the latest release; this supersedes the "published by hand"
  bullet of ADR 0002.
- The pure parsing and rendering logic lives in `scripts/release/conventionalCommits.ts` with a sibling test; the
  runner `release.ts` holds the I/O. Both run on plain Node via type stripping; no release tooling is added.

## Consequences

- One click releases; nobody edits version files by hand. A commit message that does not follow Conventional
  Commits is invisible to the version calculation and to the release notes, so `feat`/`fix` discipline matters.
- A failed build leaves the bump commit, the tag and the draft in place. "Re-run failed jobs" on the same run
  finishes the release; starting a new run would find no new commits and stop.
- Release notes list commits, not pull requests, which fits a repository that commits to `master` directly.
- `master` has no branch protection; if it gets one, the workflow needs a token or GitHub App allowed to bypass it.
