import { describe, expect, it } from "vitest";
import { KeyTranslator, type KeyPress } from "./keyTranslation";

function press(key: string, code: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return { key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
}

describe("KeyTranslator", () => {
  it("lets plain keys, umlauts and named keys pass", () => {
    const translator = new KeyTranslator();
    expect(translator.keyDown(press("a", "KeyA"))).toEqual({ kind: "pass" });
    expect(translator.keyDown(press("ä", "Quote"))).toEqual({ kind: "pass" });
    expect(translator.keyDown(press("Enter", "Enter"))).toEqual({ kind: "pass" });
    expect(translator.keyDown(press("ArrowLeft", "ArrowLeft", { altKey: true }))).toEqual({ kind: "pass" });
    expect(translator.keyUp(press("a", "KeyA"))).toEqual({ kind: "pass" });
  });

  it("turns ⌘ into Control and lets the ⌘ keyup follow the Control keyup", () => {
    const translator = new KeyTranslator();
    expect(translator.keyDown(press("Meta", "MetaLeft", { metaKey: true }))).toEqual({
      kind: "replace",
      press: press("Control", "ControlLeft", { ctrlKey: true }),
    });
    expect(translator.keyUp(press("Meta", "MetaRight"))).toEqual({ kind: "prepend", press: press("Control", "ControlRight") });
  });

  it("types the characters of ⌥ as text, but not a dead key or a ⌥ shortcut with ⌘ or ⌃", () => {
    const translator = new KeyTranslator();
    expect(translator.keyDown(press("@", "KeyL", { altKey: true }))).toEqual({ kind: "text", text: "@" });
    expect(translator.keyDown(press("\\", "Digit7", { altKey: true, shiftKey: true }))).toEqual({ kind: "text", text: "\\" });
    expect(translator.keyDown(press("Dead", "KeyN", { altKey: true }))).toEqual({ kind: "pass" });
    expect(translator.keyDown(press("@", "KeyL", { altKey: true, metaKey: true }))).toEqual({ kind: "pass" });
  });

  it("moves a letter shortcut to the US key of its letter and releases that key", () => {
    const translator = new KeyTranslator();
    const undo = translator.keyDown(press("z", "KeyY", { ctrlKey: true }));
    expect(undo).toEqual({ kind: "replace", press: press("z", "KeyZ", { ctrlKey: true }) });
    expect(translator.keyUp(press("z", "KeyY"))).toEqual({ kind: "replace", press: press("z", "KeyZ") });
    expect(translator.keyUp(press("z", "KeyY"))).toEqual({ kind: "pass" });
    expect(translator.keyDown(press("y", "KeyZ", { metaKey: true }))).toEqual({ kind: "replace", press: press("y", "KeyY", { metaKey: true }) });
  });

  it("releases a key typed after a shortcut on it whose keyup a Mac dropped under ⌘", () => {
    const translator = new KeyTranslator();
    translator.keyDown(press("z", "KeyY", { metaKey: true }));
    expect(translator.keyDown(press("z", "KeyY"))).toEqual({ kind: "pass" });
    expect(translator.keyUp(press("z", "KeyY"))).toEqual({ kind: "pass" });
  });

  it("leaves shortcuts alone whose letter sits on its US key or that are no letter", () => {
    const translator = new KeyTranslator();
    expect(translator.keyDown(press("a", "KeyA", { metaKey: true }))).toEqual({ kind: "pass" });
    expect(translator.keyDown(press("+", "BracketRight", { metaKey: true }))).toEqual({ kind: "pass" });
    expect(translator.keyDown(press("z", "KeyY"))).toEqual({ kind: "pass" });
  });
});
