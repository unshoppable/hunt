import { commandOf, bindingsOf, formatShortcut, matchesCommand, type CommandId, type KeyPress } from "../state/keymap";
import { useSettingsStore } from "../state/settings";

/** Whether `event` presses a binding of `id`; reads the keymap at press time, so a change in the settings applies at once. */
export function isShortcut(event: KeyPress, id: CommandId): boolean {
  return matchesCommand(event, useSettingsStore.getState().keymap, id);
}

/** The first of `ids` whose binding `event` presses, or null. */
export function shortcutCommand<T extends CommandId>(event: KeyPress, ids: readonly T[]): T | null {
  return commandOf(event, useSettingsStore.getState().keymap, ids);
}

/** The first binding of `id` as macOS shows it (`⌘S`), or null while it is unbound; follows keymap changes. */
export function useShortcutLabel(id: CommandId): string | null {
  const shortcut = useSettingsStore((state) => bindingsOf(state.keymap, id)[0]);
  return shortcut ? formatShortcut(shortcut) : null;
}

/** `title` with the shortcut `label` in parentheses, as tooltips show it; `title` alone when there is none. */
export function withShortcut(title: string, label: string | null): string {
  return label ? `${title} (${label})` : title;
}
