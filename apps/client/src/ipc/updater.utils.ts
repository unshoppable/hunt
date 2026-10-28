import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

export type { DownloadEvent, Update };

/** Version of the running build, from tauri.conf.json. */
export function appVersion(): Promise<string> {
  return getVersion();
}

/**
 * Asks the release feed (`plugins.updater.endpoints` in tauri.conf.json) for a newer build. Resolves with the update
 * when one exists, with null when this build is current, and rejects when the feed is unreachable or has no release.
 */
export function checkForUpdate(): Promise<Update | null> {
  return check();
}

/** Downloads and installs `update`, reporting download progress; the app keeps running until `relaunchApp`. */
export function installUpdate(update: Update, onProgress: (event: DownloadEvent) => void): Promise<void> {
  return update.downloadAndInstall(onProgress);
}

/** Quits and starts the installed build. */
export function relaunchApp(): Promise<void> {
  return relaunch();
}
