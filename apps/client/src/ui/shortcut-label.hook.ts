import type { CommandId } from "../common/keymap/keymap-commands.data";
import { useSettingsStore } from "../settings/settings.store";

/** The first binding of `id` as macOS shows it (`⌘S`), or null while it is unbound or `id` is null; follows keymap changes. */
export function useShortcutLabel(id: CommandId | null): string | null {
  return useSettingsStore((state) => (id ? state.keymap.labelOf(id) : null));
}
