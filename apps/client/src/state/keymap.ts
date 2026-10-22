/**
 * The keymap: every keyboard shortcut Hunt handles itself, with its default bindings and the user's overrides.
 *
 * A shortcut is a canonical string of modifiers in macOS order and a key, joined by `+`: `Ctrl+Alt+Shift+Meta+e`.
 * Letters and digits are lower case; digits always name the key, not the character Shift or ⌥ makes of it, and
 * letters typed with ⌥ name the key too. Other keys keep their `KeyboardEvent.key` name (`[`, `,`, `Tab`, `Escape`,
 * `ArrowLeft`), the space bar is `Space`.
 */

/** Where a command listens; two commands of the same scope cannot share a shortcut. */
export type KeymapScope = "app" | "sidebar";

export type KeymapCommand = {
  id: string;
  label: string;
  /** Heading the settings page lists the command under. */
  group: string;
  scope: KeymapScope;
  defaults: readonly string[];
  /** A fixed trigger next to the bindings that the keymap does not change. */
  note?: string;
};

export const KEYMAP_COMMANDS = [
  { id: "app.openSettings", label: "Open settings", group: "General", scope: "app", defaults: ["Meta+,"] },
  { id: "session.next", label: "Next session", group: "Sessions", scope: "app", defaults: ["Ctrl+Tab"] },
  { id: "session.previous", label: "Previous session", group: "Sessions", scope: "app", defaults: ["Ctrl+Shift+Tab"] },
  { id: "session.remove", label: "Remove the selected session", group: "Sessions", scope: "sidebar", defaults: ["Meta+w"], note: "while the focus is in the sidebar" },
  { id: "chat.interrupt", label: "Interrupt the agent's turn", group: "Chat", scope: "app", defaults: ["Escape"] },
  { id: "chat.toggleVerbose", label: "Toggle verbose tool output", group: "Chat", scope: "app", defaults: ["Ctrl+o"] },
  { id: "chat.cycleMode", label: "Cycle the permission mode", group: "Chat", scope: "app", defaults: ["Shift+Tab"] },
  {
    id: "chat.sendNow",
    label: "Send now, stopping the agent's turn",
    group: "Chat",
    scope: "app",
    defaults: ["Ctrl+Enter", "Meta+Enter"],
    note: "in the prompt box; sends the first queued prompt while the box is empty",
  },
  { id: "changes.toggleChecked", label: "Check or uncheck the selected file", group: "Changes", scope: "app", defaults: ["Meta+Space"], note: "also Space in the change list" },
  { id: "editor.save", label: "Save all files with unsaved edits", group: "Editor", scope: "app", defaults: ["Meta+s"] },
  { id: "editor.reformat", label: "Reformat file and remove unused imports", group: "Editor", scope: "app", defaults: ["Meta+g"] },
  { id: "editor.rename", label: "Rename the symbol and its usages", group: "Editor", scope: "app", defaults: ["Meta+ü"] },
  { id: "editor.goToFile", label: "Go to file", group: "Editor", scope: "app", defaults: ["Meta+p"], note: "also ⇧⇧" },
  { id: "editor.findInFiles", label: "Find in files", group: "Editor", scope: "app", defaults: ["Shift+Meta+f"] },
  { id: "editor.completion", label: "Show completions", group: "Editor", scope: "app", defaults: ["Ctrl+Space", "Alt+Space"] },
  {
    id: "editor.selectAllOccurrences",
    label: "Select all occurrences of the selected text",
    group: "Editor",
    scope: "app",
    defaults: ["Meta+b"],
    note: "the word at the cursor without a selection",
  },
  { id: "editor.back", label: "Navigate back", group: "Editor", scope: "app", defaults: ["Meta+[", "Alt+Meta+ArrowLeft"] },
  { id: "editor.forward", label: "Navigate forward", group: "Editor", scope: "app", defaults: ["Meta+]", "Alt+Meta+ArrowRight"] },
  { id: "editor.selectInTree", label: "Select the file in the project tree; in the change list, open it in the editor", group: "Editor", scope: "app", defaults: ["Shift+Meta+2"] },
  { id: "editor.closeTab", label: "Close tab", group: "Editor", scope: "app", defaults: ["Meta+w"] },
  { id: "editor.closeAllTabs", label: "Close all tabs", group: "Editor", scope: "app", defaults: ["Shift+Meta+w"] },
  { id: "editor.moveTabLeft", label: "Move tab to the pane on the left", group: "Editor", scope: "app", defaults: ["Meta+e"] },
  { id: "editor.moveTabRight", label: "Move tab to the pane on the right", group: "Editor", scope: "app", defaults: ["Meta+r"] },
  { id: "editor.moveTabUp", label: "Move tab to the pane above", group: "Editor", scope: "app", defaults: ["Shift+Meta+e"] },
  { id: "editor.moveTabDown", label: "Move tab to the pane below", group: "Editor", scope: "app", defaults: ["Shift+Meta+r"] },
] as const satisfies readonly KeymapCommand[];

export type CommandId = (typeof KEYMAP_COMMANDS)[number]["id"];

/** The user's bindings per command; a command without an entry has its defaults. An empty list unbinds it. */
export type Keymap = Partial<Record<CommandId, string[]>>;

const COMMANDS_BY_ID = new Map<string, KeymapCommand>(KEYMAP_COMMANDS.map((command) => [command.id, command]));

export function keymapCommand(id: CommandId): KeymapCommand {
  const command = COMMANDS_BY_ID.get(id);
  if (!command) throw new Error(`unknown keymap command ${id}`);
  return command;
}

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_SYMBOLS: Record<Modifier, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };

const KEY_SYMBOLS: Record<string, string> = {
  Escape: "Esc",
  Tab: "⇥",
  Enter: "⏎",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

/** Keys that never type text, so a shortcut may use them with Shift alone or without any modifier. */
const NON_TEXT_KEYS = new Set(["Escape", "Tab", "Enter", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
const FUNCTION_KEY = /^F([1-9]|1[0-9]|20)$/;

/** Key names that are only a modifier or no key at all; a press of one of them is no shortcut yet. */
const NO_SHORTCUT_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "OS", "Dead", "Unidentified", "Process"]);

export type KeyPress = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The key part of a shortcut for `event`, or null when the press is a modifier alone or a dead key. */
function keyName(event: KeyPress): string | null {
  if (NO_SHORTCUT_KEYS.has(event.key)) return null;
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter && event.altKey) return letter[1].toLowerCase();
  if (event.key === " " || event.code === "Space") return "Space";
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

/** The canonical shortcut `event` presses, or null while only modifiers are held. */
export function shortcutFromEvent(event: KeyPress): string | null {
  const key = keyName(event);
  if (!key) return null;
  const held: Record<Modifier, boolean> = { Ctrl: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey, Meta: event.metaKey };
  return [...MODIFIERS.filter((modifier) => held[modifier]), key].join("+");
}

/** Splits a canonical shortcut into its modifiers and key; the key may itself be `+`. */
function parseShortcut(shortcut: string): { modifiers: Modifier[]; key: string } {
  const modifiers: Modifier[] = [];
  let rest = shortcut;
  for (const modifier of MODIFIERS) {
    if (!rest.startsWith(`${modifier}+`) || rest.length === modifier.length + 1) continue;
    modifiers.push(modifier);
    rest = rest.slice(modifier.length + 1);
  }
  return { modifiers, key: rest };
}

/** The shortcut as macOS menus show it, e.g. `⇧⌘E`, `⌃⇥` or `⌥⌘←`. */
export function formatShortcut(shortcut: string): string {
  const { modifiers, key } = parseShortcut(shortcut);
  const symbol = KEY_SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return modifiers.map((modifier) => MODIFIER_SYMBOLS[modifier]).join("") + symbol;
}

/**
 * Why `shortcut` cannot be a binding, or null when it can: a key that types text needs ⌘, ⌃ or ⌥, else every
 * text field and editor would lose that character.
 */
export function shortcutProblem(shortcut: string): string | null {
  const { modifiers, key } = parseShortcut(shortcut);
  if (!key) return "Press a key, not only modifiers.";
  if (NON_TEXT_KEYS.has(key) || FUNCTION_KEY.test(key)) return null;
  if (modifiers.some((modifier) => modifier !== "Shift")) return null;
  return "A key that types text needs ⌘, ⌃ or ⌥.";
}

/** The bindings of `id` under `keymap`. */
export function bindingsOf(keymap: Keymap, id: CommandId): readonly string[] {
  return keymap[id] ?? keymapCommand(id).defaults;
}

/** Whether `id` is bound as by default under `keymap`. */
export function isDefaultBinding(keymap: Keymap, id: CommandId): boolean {
  return sameShortcuts(bindingsOf(keymap, id), keymapCommand(id).defaults);
}

function sameShortcuts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((shortcut, index) => shortcut === right[index]);
}

/** Whether `event` presses one of the bindings of `id` under `keymap`. */
export function matchesCommand(event: KeyPress, keymap: Keymap, id: CommandId): boolean {
  const shortcut = shortcutFromEvent(event);
  return !!shortcut && bindingsOf(keymap, id).includes(shortcut);
}

/** The first of `ids` that `event` presses under `keymap`, or null. */
export function commandOf<T extends CommandId>(event: KeyPress, keymap: Keymap, ids: readonly T[]): T | null {
  const shortcut = shortcutFromEvent(event);
  if (!shortcut) return null;
  return ids.find((id) => bindingsOf(keymap, id).includes(shortcut)) ?? null;
}

/** `keymap` with `id` bound to `shortcuts`, without duplicates; bindings equal to the defaults drop the entry. */
export function withBindings(keymap: Keymap, id: CommandId, shortcuts: readonly string[]): Keymap {
  const unique = [...new Set(shortcuts)];
  const { [id]: _previous, ...rest } = keymap;
  return sameShortcuts(unique, keymapCommand(id).defaults) ? rest : { ...rest, [id]: unique };
}

/** The other commands of the scope of `id` that share one of its bindings under `keymap`. */
export function conflictsOf(keymap: Keymap, id: CommandId): CommandId[] {
  const own = bindingsOf(keymap, id);
  const scope = keymapCommand(id).scope;
  return KEYMAP_COMMANDS.filter(
    (command) => command.id !== id && command.scope === scope && bindingsOf(keymap, command.id).some((shortcut) => own.includes(shortcut)),
  ).map((command) => command.id);
}

/** A stored keymap with unknown commands, malformed lists and bindings equal to the defaults removed. */
export function normalizeKeymap(stored: unknown): Keymap {
  if (!stored || typeof stored !== "object") return {};
  let keymap: Keymap = {};
  for (const [id, shortcuts] of Object.entries(stored)) {
    if (!COMMANDS_BY_ID.has(id) || !Array.isArray(shortcuts)) continue;
    const valid = shortcuts.filter((shortcut): shortcut is string => typeof shortcut === "string" && !shortcutProblem(shortcut));
    keymap = withBindings(keymap, id as CommandId, valid);
  }
  return keymap;
}
