import { ask } from "@tauri-apps/plugin-dialog";

/**
 * Asks the user to confirm a destructive action with a native warning dialog and resolves to whether they agreed.
 * `window.confirm` is a no-op inside Tauri's webview, so every confirmation must go through this helper.
 */
export function confirmDestructive(message: string, okLabel = "Delete"): Promise<boolean> {
  return ask(message, { kind: "warning", okLabel, cancelLabel: "Cancel" });
}
