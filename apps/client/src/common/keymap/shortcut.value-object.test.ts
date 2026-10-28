import { describe, expect, it } from "vitest";
import { Shortcut, type KeyPress } from "./shortcut.value-object";

function press(key: string, code: string, modifiers: Partial<Pick<KeyPress, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}): KeyPress {
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

function textOf(shortcut: Shortcut | null): string | null {
  return shortcut?.text ?? null;
}

describe("Shortcut", () => {
  it("rejects a shortcut without a key", () => {
    expect(() => new Shortcut({ modifiers: ["Meta"], key: "" })).toThrow(/has a key/);
  });

  it("rejects a modifier it does not know", () => {
    expect(() => new Shortcut({ modifiers: ["Hyper" as "Meta"], key: "e" })).toThrow();
  });

  it("rejects modifiers out of macOS order", () => {
    expect(() => new Shortcut({ modifiers: ["Meta", "Shift"], key: "e" })).toThrow(/order Ctrl, Alt, Shift, Meta/);
  });

  it("rejects a modifier held twice", () => {
    expect(() => new Shortcut({ modifiers: ["Shift", "Shift"], key: "e" })).toThrow(/each modifier once/);
  });

  it("joins the held modifiers of a press in macOS order with the lower-case key", () => {
    expect(textOf(Shortcut.fromEvent(press("E", "KeyE", { metaKey: true, shiftKey: true })))).toBe("Shift+Meta+e");
    expect(textOf(Shortcut.fromEvent(press("Tab", "Tab", { ctrlKey: true, shiftKey: true })))).toBe("Ctrl+Shift+Tab");
    expect(textOf(Shortcut.fromEvent(press(",", "Comma", { metaKey: true })))).toBe("Meta+,");
  });

  it("names digits and ⌥ letters of a press by their key, not the character they type", () => {
    expect(textOf(Shortcut.fromEvent(press('"', "Digit2", { metaKey: true, shiftKey: true })))).toBe("Shift+Meta+2");
    expect(textOf(Shortcut.fromEvent(press("€", "KeyE", { altKey: true })))).toBe("Alt+e");
  });

  it("keeps the layout's letter of a press without ⌥ and names the space bar", () => {
    expect(textOf(Shortcut.fromEvent(press("z", "KeyY", { metaKey: true })))).toBe("Meta+z");
    expect(textOf(Shortcut.fromEvent(press(" ", "Space", { metaKey: true })))).toBe("Meta+Space");
    expect(textOf(Shortcut.fromEvent(press(" ", "Space", { altKey: true })))).toBe("Alt+Space");
  });

  it("is no shortcut while only modifiers or a dead key are pressed", () => {
    expect(Shortcut.fromEvent(press("Meta", "MetaLeft", { metaKey: true }))).toBeNull();
    expect(Shortcut.fromEvent(press("Shift", "ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(Shortcut.fromEvent(press("Dead", "Equal"))).toBeNull();
  });

  it("shows the held modifiers in macOS order", () => {
    expect(Shortcut.modifiersLabel(press("Meta", "MetaLeft", { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }))).toBe("⌃⌥⇧⌘");
    expect(Shortcut.modifiersLabel(press("Shift", "ShiftLeft", { shiftKey: true }))).toBe("⇧");
    expect(Shortcut.modifiersLabel(press("a", "KeyA"))).toBe("");
  });

  it("parses its canonical text back into modifiers and key, a plus sign being a key", () => {
    expect(Shortcut.parse("Alt+Meta+ArrowLeft")?.toJSON()).toEqual({ modifiers: ["Alt", "Meta"], key: "ArrowLeft" });
    expect(Shortcut.parse("Meta++")?.toJSON()).toEqual({ modifiers: ["Meta"], key: "+" });
    for (const text of ["Shift+Meta+e", "Ctrl+Tab", "Escape", "Meta++", "Meta+"]) {
      expect(Shortcut.parse(text)?.text).toBe(text);
    }
    expect(Shortcut.parse("")).toBeNull();
  });

  it("shows modifiers as macOS symbols and special keys as glyphs", () => {
    expect(Shortcut.parse("Shift+Meta+e")?.label).toBe("⇧⌘E");
    expect(Shortcut.parse("Alt+Meta+ArrowLeft")?.label).toBe("⌥⌘←");
    expect(Shortcut.parse("Ctrl+Tab")?.label).toBe("⌃⇥");
    expect(Shortcut.parse("Escape")?.label).toBe("Esc");
    expect(Shortcut.parse("Meta+Space")?.label).toBe("⌘Space");
    expect(Shortcut.parse("Meta++")?.label).toBe("⌘+");
  });

  it("can be a binding with a key that types no text, or with ⌘, ⌃ or ⌥", () => {
    for (const text of ["Escape", "Shift+Tab", "F5", "Ctrl+o", "Alt+e"]) {
      expect(Shortcut.parse(text)?.bindingProblem).toBeNull();
    }
  });

  it("cannot be a binding with a text key alone or with Shift alone", () => {
    for (const text of ["e", "Shift+e", "Space"]) {
      expect(Shortcut.parse(text)?.bindingProblem).toBe("A key that types text needs ⌘, ⌃ or ⌥.");
    }
  });

  it("equals the shortcut of the same modifiers and key", () => {
    expect(Shortcut.parse("Shift+Meta+e")?.isEqualTo(Shortcut.fromEvent(press("E", "KeyE", { metaKey: true, shiftKey: true })))).toBe(true);
    expect(Shortcut.parse("Meta+e")?.isEqualTo(Shortcut.parse("Shift+Meta+e"))).toBe(false);
  });
});
