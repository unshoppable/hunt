import { commandOf, bindingsOf, formatShortcut, matchesCommand, type CommandId, type KeyPress } from "../state/keymap";
import { useSettingsStore } from "../state/settings";

/** Marks an element whose keys, shortcuts included, belong to a remote machine, such as the Desktop tab's stream. */
export const REMOTE_INPUT_ATTRIBUTE = "data-remote-input";

/** A key press; one from a keyboard event carries its target, which `isRemoteInput` checks. */
type ShortcutPress = KeyPress & { target?: EventTarget | null };

/** Whether `target` lies inside an element marked with REMOTE_INPUT_ATTRIBUTE, whose keys no shortcut of Hunt takes. */
export function isRemoteInput(target: EventTarget | null | undefined): boolean {
  return typeof Element !== "undefined" && target instanceof Element && Boolean(target.closest(`[${REMOTE_INPUT_ATTRIBUTE}]`));
}

/** Whether `event` presses a binding of `id`; reads the keymap at press time, so a change in the settings applies at once. */
export function isShortcut(event: ShortcutPress, id: CommandId): boolean {
  if (isRemoteInput(event.target)) return false;
  return matchesCommand(event, useSettingsStore.getState().keymap, id);
}

/** The first of `ids` whose binding `event` presses, or null. */
export function shortcutCommand<T extends CommandId>(event: ShortcutPress, ids: readonly T[]): T | null {
  if (isRemoteInput(event.target)) return null;
  return commandOf(event, useSettingsStore.getState().keymap, ids);
}

/** The first binding of `id` as macOS shows it (`⌘S`), or null while it is unbound; reads the keymap now. */
export function shortcutLabel(id: CommandId): string | null {
  const shortcut = bindingsOf(useSettingsStore.getState().keymap, id)[0];
  return shortcut ? formatShortcut(shortcut) : null;
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
