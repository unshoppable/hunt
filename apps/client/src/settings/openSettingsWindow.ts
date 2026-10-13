import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createWindow, type WindowDefaults } from "../ui/nativeWindow";

/** Label of the single settings window; the capability in src-tauri/capabilities/default.json names it too. */
export const SETTINGS_WINDOW_LABEL = "settings";

/** A settings page another window can open directly; the window reads it from the URL hash or `settings:show-page`. */
export type SettingsPage = "updates";

const SETTINGS_WINDOW_DEFAULTS: WindowDefaults = { width: 760, height: 620, minWidth: 640, minHeight: 480, backgroundColor: "#21252d" };

/** Idle time after the main window mounts before the settings window boots hidden. */
const WARM_DELAY_MS = 400;

/** The settings window while it is being created, so a click meanwhile shows it instead of failing on the taken label. */
let creating: Promise<WebviewWindow> | null = null;

/**
 * Opens the settings window (see SettingsWindow.tsx), on `page` when given: a window booted ahead of time or hidden
 * by its close is only shown, otherwise a new one starts and shows itself once rendered. It has the main window's
 * chrome and opens where it was last left (see ui/nativeWindow.ts); the first time it is centered.
 */
export async function openSettingsWindow(page?: SettingsPage): Promise<void> {
  const existing = await (creating ?? WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL));
  if (!existing) {
    await createSettingsWindow(page ? `settings.html#${page}` : "settings.html");
    return;
  }
  if (page) {
    await emitTo(SETTINGS_WINDOW_LABEL, "settings:show-page", { page });
  }
  await existing.show();
  await existing.setFocus();
}

/** Boots the settings window hidden so that ⌘, or the gear button only has to show it. Call once when the main window mounts. */
export function keepSettingsWindowWarm(): void {
  globalThis.setTimeout(() => {
    void (async () => {
      if (creating || (await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL))) return;
      await createSettingsWindow("settings.html?warm=1").catch((reason) => console.error(`failed to warm the settings window: ${reason}`));
    })();
  }, WARM_DELAY_MS);
}

async function createSettingsWindow(url: string): Promise<WebviewWindow> {
  creating = createWindow("settings", SETTINGS_WINDOW_LABEL, { url, title: "Settings", ...SETTINGS_WINDOW_DEFAULTS });
  try {
    return await creating;
  } finally {
    creating = null;
  }
}
