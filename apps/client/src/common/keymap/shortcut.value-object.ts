import * as z from "zod/mini";
import { ValueObject } from "../../../../../libs/domain/src/model/value-object.model.ts";

/** The modifiers in macOS order, the order in which a shortcut's text names them. */
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

const MODIFIERS_RULE = "a shortcut holds each modifier once, in the order Ctrl, Alt, Shift, Meta";
const KEY_RULE = "a shortcut has a key, not only modifiers";

/** Whether `modifiers` follow MODIFIERS strictly, which also makes each of them unique. */
function isInMacOrder(modifiers: readonly Modifier[]): boolean {
  return modifiers.every((modifier, index) => index === 0 || MODIFIERS.indexOf(modifiers[index - 1]) < MODIFIERS.indexOf(modifier));
}

const ZodShortcutState = z.object({
  modifiers: z.array(z.enum(MODIFIERS)).check(z.refine(isInMacOrder, MODIFIERS_RULE)),
  key: z.string().check(z.minLength(1, KEY_RULE)),
});

export type KeyPress = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The modifier state of a key press. */
type ModifierPress = Pick<KeyPress, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The modifiers `event` holds, in macOS order. */
function heldModifiers(event: ModifierPress): Modifier[] {
  const held: Record<Modifier, boolean> = { Ctrl: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey, Meta: event.metaKey };
  return MODIFIERS.filter((modifier) => held[modifier]);
}

export interface Shortcut extends z.infer<typeof ZodShortcutState> {}

/**
 * A keyboard shortcut: the held modifiers and one key. Its `text` is the canonical string the keymap stores, the
 * modifiers in macOS order and the key joined by `+` (`Ctrl+Alt+Shift+Meta+e`). Letters and digits are lower case;
 * digits always name the key, not the character Shift or ⌥ makes of it, and letters typed with ⌥ name the key too.
 * Other keys keep their `KeyboardEvent.key` name (`[`, `,`, `Tab`, `Escape`, `ArrowLeft`), the space bar is `Space`.
 */
export class Shortcut extends ValueObject<typeof ZodShortcutState> {
  static readonly schema = ZodShortcutState;

  constructor(value: z.input<typeof ZodShortcutState>) {
    super(value);
  }

  /** The shortcut a canonical `text` spells, its key possibly `+` itself; null for an empty text. */
  static parse(text: string): Shortcut | null {
    const modifiers: Modifier[] = [];
    let rest = text;
    for (const modifier of MODIFIERS) {
      if (!rest.startsWith(`${modifier}+`) || rest.length === modifier.length + 1) continue;
      modifiers.push(modifier);
      rest = rest.slice(modifier.length + 1);
    }
    return rest ? new Shortcut({ modifiers, key: rest }) : null;
  }

  /** The shortcut `event` presses, or null while only modifiers are held or a dead key is pressed. */
  static fromEvent(event: KeyPress): Shortcut | null {
    const key = keyName(event);
    if (!key) return null;
    return new Shortcut({ modifiers: heldModifiers(event), key });
  }

  /** The modifiers `event` holds as macOS shows them, e.g. `⌃⇧` while a shortcut is being pressed; empty without any. */
  static modifiersLabel(event: ModifierPress): string {
    return heldModifiers(event).map((modifier) => MODIFIER_SYMBOLS[modifier]).join("");
  }

  /** The canonical string, e.g. `Shift+Meta+e`. */
  get text(): string {
    return [...this.modifiers, this.key].join("+");
  }

  /** The shortcut as macOS menus show it, e.g. `⇧⌘E`, `⌃⇥` or `⌥⌘←`. */
  get label(): string {
    const symbol = KEY_SYMBOLS[this.key] ?? (this.key.length === 1 ? this.key.toUpperCase() : this.key);
    return this.modifiers.map((modifier) => MODIFIER_SYMBOLS[modifier]).join("") + symbol;
  }

  /**
   * Why the shortcut cannot be a binding, or null when it can: a key that types text needs ⌘, ⌃ or ⌥, else every
   * text field and editor would lose that character.
   */
  get bindingProblem(): string | null {
    if (NON_TEXT_KEYS.has(this.key) || FUNCTION_KEY.test(this.key)) return null;
    if (this.modifiers.some((modifier) => modifier !== "Shift")) return null;
    return "A key that types text needs ⌘, ⌃ or ⌥.";
  }
}

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
