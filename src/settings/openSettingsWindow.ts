import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openOrFocusWindow } from "../ui/nativeWindow";

/** Label of the single settings window; the capability in src-tauri/capabilities/default.json names it too. */
export const SETTINGS_WINDOW_LABEL = "settings";

/** A settings page another window can open directly; the window reads it from the URL hash or `settings:show-page`. */
export type SettingsPage = "updates";

/**
 * Opens the settings window (see SettingsWindow.tsx) or brings the open one to the front, on `page` when given. It
 * has the main window's chrome and opens where it was last left (see ui/nativeWindow.ts); the first time it is centered.
 */
export async function openSettingsWindow(page?: SettingsPage): Promise<void> {
  const isOpen = Boolean(await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL));
  await openOrFocusWindow("settings", SETTINGS_WINDOW_LABEL, {
    url: page ? `settings.html#${page}` : "settings.html",
    title: "Settings",
    width: 760,
    height: 620,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#21252d",
  });
  if (isOpen && page) {
    await emitTo(SETTINGS_WINDOW_LABEL, "settings:show-page", { page });
  }
}
