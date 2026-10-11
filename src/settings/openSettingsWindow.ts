import { openOrFocusWindow } from "../ui/nativeWindow";

/** Label of the single settings window; the capability in src-tauri/capabilities/default.json names it too. */
export const SETTINGS_WINDOW_LABEL = "settings";

/**
 * Opens the settings window (see SettingsWindow.tsx) or brings the open one to the front. It has the main window's
 * chrome and opens where it was last left (see ui/nativeWindow.ts); the first time it is centered.
 */
export async function openSettingsWindow(): Promise<void> {
  await openOrFocusWindow("settings", SETTINGS_WINDOW_LABEL, {
    url: "settings.html",
    title: "Settings",
    width: 760,
    height: 620,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#21252d",
  });
}
