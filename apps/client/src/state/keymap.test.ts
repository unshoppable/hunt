import { describe, expect, it } from "vitest";
import {
  KEYMAP_COMMANDS,
  bindingsOf,
  commandOf,
  conflictsOf,
  formatShortcut,
  isDefaultBinding,
  matchesCommand,
  normalizeKeymap,
  shortcutFromEvent,
  shortcutProblem,
  withBindings,
  type KeyPress,
} from "./keymap";

function press(key: string, code: string, modifiers: Partial<Pick<KeyPress, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}): KeyPress {
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

describe("shortcutFromEvent", () => {
  it("joins the held modifiers in macOS order with the lower-case key", () => {
    expect(shortcutFromEvent(press("E", "KeyE", { metaKey: true, shiftKey: true }))).toBe("Shift+Meta+e");
    expect(shortcutFromEvent(press("Tab", "Tab", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Tab");
    expect(shortcutFromEvent(press(",", "Comma", { metaKey: true }))).toBe("Meta+,");
  });

  it("names digits and ⌥ letters by their key, not the character they type", () => {
    expect(shortcutFromEvent(press('"', "Digit2", { metaKey: true, shiftKey: true }))).toBe("Shift+Meta+2");
    expect(shortcutFromEvent(press("€", "KeyE", { altKey: true }))).toBe("Alt+e");
  });

  it("keeps the layout's letter without ⌥ and names the space bar", () => {
    expect(shortcutFromEvent(press("z", "KeyY", { metaKey: true }))).toBe("Meta+z");
    expect(shortcutFromEvent(press(" ", "Space", { metaKey: true }))).toBe("Meta+Space");
    expect(shortcutFromEvent(press("\u00a0", "Space", { altKey: true }))).toBe("Alt+Space");
  });

  it("is null while only modifiers or a dead key are pressed", () => {
    expect(shortcutFromEvent(press("Meta", "MetaLeft", { metaKey: true }))).toBeNull();
    expect(shortcutFromEvent(press("Shift", "ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(shortcutFromEvent(press("Dead", "Equal"))).toBeNull();
  });
});

describe("formatShortcut", () => {
  it("shows modifiers as macOS symbols and special keys as glyphs", () => {
    expect(formatShortcut("Shift+Meta+e")).toBe("⇧⌘E");
    expect(formatShortcut("Alt+Meta+ArrowLeft")).toBe("⌥⌘←");
    expect(formatShortcut("Ctrl+Tab")).toBe("⌃⇥");
    expect(formatShortcut("Escape")).toBe("Esc");
    expect(formatShortcut("Meta+Space")).toBe("⌘Space");
  });

  it("reads a plus sign as the key", () => {
    expect(formatShortcut("Meta++")).toBe("⌘+");
  });
});

describe("shortcutProblem", () => {
  it("accepts keys that type no text without a modifier and text keys with ⌘, ⌃ or ⌥", () => {
    expect(shortcutProblem("Escape")).toBeNull();
    expect(shortcutProblem("Shift+Tab")).toBeNull();
    expect(shortcutProblem("F5")).toBeNull();
    expect(shortcutProblem("Ctrl+o")).toBeNull();
    expect(shortcutProblem("Alt+e")).toBeNull();
  });

  it("rejects a text key alone or with Shift alone", () => {
    expect(shortcutProblem("e")).not.toBeNull();
    expect(shortcutProblem("Shift+e")).not.toBeNull();
    expect(shortcutProblem("Space")).not.toBeNull();
  });
});

describe("bindings", () => {
  it("fall back to the defaults and match the pressed shortcut", () => {
    expect(bindingsOf({}, "editor.back")).toEqual(["Meta+[", "Alt+Meta+ArrowLeft"]);
    expect(matchesCommand(press("ArrowLeft", "ArrowLeft", { metaKey: true, altKey: true }), {}, "editor.back")).toBe(true);
    expect(matchesCommand(press("[", "BracketLeft", { metaKey: true, shiftKey: true }), {}, "editor.back")).toBe(false);
  });

  it("follow the user's override and may be empty", () => {
    const keymap = withBindings({}, "editor.closeTab", ["Ctrl+w"]);
    expect(matchesCommand(press("w", "KeyW", { ctrlKey: true }), keymap, "editor.closeTab")).toBe(true);
    expect(matchesCommand(press("w", "KeyW", { metaKey: true }), keymap, "editor.closeTab")).toBe(false);
    expect(bindingsOf(withBindings({}, "editor.closeTab", []), "editor.closeTab")).toEqual([]);
  });

  it("drop the override once it equals the defaults again", () => {
    const keymap = withBindings(withBindings({}, "editor.save", ["Meta+d"]), "editor.save", ["Meta+s", "Meta+s"]);
    expect(keymap).toEqual({});
    expect(isDefaultBinding(keymap, "editor.save")).toBe(true);
  });

  it("pick the first command of a list that the press is bound to", () => {
    const ids = ["editor.moveTabLeft", "editor.moveTabUp"] as const;
    expect(commandOf(press("E", "KeyE", { metaKey: true, shiftKey: true }), {}, ids)).toBe("editor.moveTabUp");
    expect(commandOf(press("x", "KeyX", { metaKey: true }), {}, ids)).toBeNull();
  });
});

describe("conflictsOf", () => {
  it("finds commands of the same scope with a shared binding", () => {
    const keymap = withBindings({}, "editor.save", ["Meta+e"]);
    expect(conflictsOf(keymap, "editor.save")).toEqual(["editor.moveTabLeft"]);
    expect(conflictsOf(keymap, "editor.moveTabLeft")).toEqual(["editor.save"]);
  });

  it("ignores commands of another scope", () => {
    expect(conflictsOf({}, "session.remove")).toEqual([]);
    expect(conflictsOf({}, "editor.closeTab")).toEqual([]);
  });

  it("finds none among the defaults", () => {
    for (const command of KEYMAP_COMMANDS) {
      expect(conflictsOf({}, command.id)).toEqual([]);
      for (const shortcut of command.defaults) {
        expect(shortcutProblem(shortcut)).toBeNull();
      }
    }
  });
});

describe("normalizeKeymap", () => {
  it("drops unknown commands, malformed lists, invalid shortcuts and default bindings", () => {
    const stored = { "editor.save": ["Meta+d", 3, "e"], "editor.closeTab": "Meta+w", "chat.cycleMode": ["Shift+Tab"], "gone.command": ["Meta+g"] };
    expect(normalizeKeymap(stored)).toEqual({ "editor.save": ["Meta+d"] });
    expect(normalizeKeymap(null)).toEqual({});
  });
});
