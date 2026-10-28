# 0002 — In-app updates come from GitHub Releases

## Date

2026-10-11

## Context

Hunt is distributed as unsigned DMGs attached to GitHub Releases of the public repository `unshoppable/hunt`.
Updating meant downloading the next DMG by hand, replacing the app in Applications and clearing the
quarantine flag again. Nothing told a user that a newer version existed.

Tauri's updater plugin can replace the app bundle in place from a JSON feed, but it needs a signing key pair of its own
(minisign, independent of Apple code signing), a feed URL and a release pipeline that produces the signed artifacts.
The app has no Apple Developer signing or notarization; adding them is out of scope for this decision.

## Decision

- `tauri-plugin-updater` and `tauri-plugin-process` are part of the app. The feed is
  `https://github.com/unshoppable/hunt/releases/latest/download/latest.json`, which GitHub serves without a token
  because the repository is public and which always points at the latest *published* (non-draft) release.
- `release.yml` builds the updater artifacts (`Hunt.app.tar.gz`, `.sig`, `latest.json`) next to the DMGs and signs
  them with the key in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The
  public key is `plugins.updater.pubkey` in `tauri.conf.json`. `createUpdaterArtifacts` lives in the CI-only
  `tauri.release.conf.json` so that a local `npm run tauri build` keeps working without the private key.
- The release stays a draft until published by hand, as before. Publishing is the moment running installs start to
  offer the update. *Superseded by ADR 0003: the release workflow publishes the draft itself once every target
  built.*
- The UI is the *Updates* page of the settings window: current version, one check when the page opens, "Download and
  install", then "Restart now". The main window checks once per launch (not in dev builds) and marks the gear button
  with a dot that opens that page. A failed background check is silent; the page reports errors.
- Every plugin call goes through `src/ipc/updater.utils.ts`; `src/settings/update-progress.utils.ts` holds the pure progress logic.

## Consequences

- Users see new versions and install them without leaving the app; the DMG stays the first-install path.
- Each release needs the version bumped in `package.json`, `tauri.conf.json` and `Cargo.toml`; the updater compares
  the feed's version with the running one, so an unbumped release is never offered.
- The private key must not be lost: the plugin only installs artifacts signed with the configured public key. A new key
  reaches users only through a DMG they install by hand.
- The app remains unsigned by Apple. The updater writes the new bundle itself, so the files carry no quarantine flag,
  but Gatekeeper behaviour on the relaunched bundle has to be confirmed with the first real release. If it blocks the
  app, the `xattr -cr /Applications/Hunt.app` workaround from the README applies; the clean fix is Apple signing and
  notarization, which would need its own decision.
