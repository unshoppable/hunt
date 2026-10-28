import type { CommandId } from "../common/keymap/keymap-commands.data";
import { useSettingsStore } from "../settings/settings.store";

/** The first binding of `id` as macOS shows it (`⌘S`), or null while it is unbound; follows keymap changes. */
export function useShortcutLabel(id: CommandId): string | null {
  return useSettingsStore((state) => state.keymap.labelOf(id));
}
