/**
 * Turns the keys a Mac sends into what the VM's desktop expects, ahead of the Waymote SDK, which sends each key as its
 * Linux key code in the gateway's US layout and its character only while no ⌘, ⌃ or ⌥ is held:
 * - ⌘ goes to the VM as Ctrl, so ⌘A, ⌘Z or ⌘L do there what they do on the Mac; Linux has no ⌘.
 * - A character typed with ⌥ (@, |, [ on a German Mac) goes as text; the SDK would send Alt and the bare key.
 * - A letter shortcut goes on the US key of the letter the Mac's layout typed, so ⌃Z on QWERTZ is Ctrl+Z there.
 * `KeyTranslator` keeps the letter keys it moved, so that their release goes to the same key.
 */

/** The fields of a `KeyboardEvent` the translation reads and writes. */
export type KeyPress = {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/**
 * What becomes of a key event: it goes on unchanged (`pass`), `press` goes instead of it (`replace`), `press` goes
 * first and then the event itself (`prepend`), or `text` is typed instead of it (`text`).
 */
export type KeyTranslation =
  | { kind: "pass" }
  | { kind: "replace"; press: KeyPress }
  | { kind: "prepend"; press: KeyPress }
  | { kind: "text"; text: string };

const PASS: KeyTranslation = { kind: "pass" };

/** The Control key that stands for the ⌘ key `code`. */
const CONTROL_FOR_META: Record<string, string> = { MetaLeft: "ControlLeft", MetaRight: "ControlRight" };

/** Translates the key events of one remote input; one instance per stream. */
export class KeyTranslator {
  /** The letter keys moved at their keydown, by the key the Mac reported. */
  private readonly movedCodes = new Map<string, string>();

  /** What becomes of the keydown `press`. */
  keyDown(press: KeyPress): KeyTranslation {
    const control = CONTROL_FOR_META[press.code];
    if (control) return { kind: "replace", press: { ...press, code: control, key: "Control", ctrlKey: true, metaKey: false } };
    const text = optionText(press);
    if (text) return { kind: "text", text };
    const letterCode = shortcutLetterCode(press);
    if (!letterCode) {
      // A key moved before whose keyup a Mac dropped under ⌘ is a key of its own again.
      this.movedCodes.delete(press.code);
      return PASS;
    }
    this.movedCodes.set(press.code, letterCode);
    return { kind: "replace", press: { ...press, code: letterCode } };
  }

  /**
   * What becomes of the keyup `press`. The ⌘ keyup still reaches the SDK after the Control keyup, since it releases
   * the keys whose keyup a Mac drops while ⌘ is held.
   */
  keyUp(press: KeyPress): KeyTranslation {
    const control = CONTROL_FOR_META[press.code];
    if (control) return { kind: "prepend", press: { ...press, code: control, key: "Control", ctrlKey: false, metaKey: false } };
    const movedCode = this.movedCodes.get(press.code);
    if (!movedCode) return PASS;
    this.movedCodes.delete(press.code);
    return { kind: "replace", press: { ...press, code: movedCode } };
  }
}

/** The character typed with ⌥ (and maybe ⇧) alone, or null; a dead key or a named key types none. */
function optionText(press: KeyPress): string | null {
  if (!press.altKey || press.ctrlKey || press.metaKey) return null;
  const characters = Array.from(press.key);
  if (characters.length !== 1) return null;
  const codePoint = characters[0].codePointAt(0) ?? 0;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return null;
  return press.key;
}

/** The US key of the letter a ⌘ or ⌃ shortcut typed, when the Mac's layout has that letter on another key. */
function shortcutLetterCode(press: KeyPress): string | null {
  if ((!press.ctrlKey && !press.metaKey) || press.altKey) return null;
  if (!/^[a-z]$/i.test(press.key) || !press.code.startsWith("Key")) return null;
  const letterCode = `Key${press.key.toUpperCase()}`;
  return letterCode === press.code ? null : letterCode;
}
