import { describe, expect, it } from "vitest";
import { KEYMAP_COMMANDS, type CommandId } from "./keymap-commands.data";
import { Keymap } from "./keymap.value-object";
import { Shortcut, type KeyPress } from "./shortcut.value-object";

function press(key: string, code: string, modifiers: Partial<Pick<KeyPress, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}): KeyPress {
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

function shortcuts(...texts: string[]): Shortcut[] {
  return texts.map((text) => {
    const shortcut = Shortcut.parse(text);
    if (!shortcut) throw new Error(`no shortcut: ${text}`);
    return shortcut;
  });
}

function textsOf(keymap: Keymap, commandId: CommandId): string[] {
  return keymap.bindingsOf(commandId).map((shortcut) => shortcut.text);
}

describe("Keymap", () => {
  it("rejects a command KEYMAP_COMMANDS does not hold", () => {
    expect(() => new Keymap({ "gone.command": ["Meta+g"] } as never)).toThrow();
  });

  it("rejects a binding that types text", () => {
    expect(() => new Keymap({ "editor.save": ["e"] })).toThrow(/needs ⌘, ⌃ or ⌥/);
  });

  it("rejects a binding without a key", () => {
    expect(() => new Keymap({ "editor.save": [""] })).toThrow(/needs ⌘, ⌃ or ⌥/);
  });

  it("rejects a command that lists a binding twice", () => {
    expect(() => new Keymap({ "editor.save": ["Meta+d", "Meta+d"] })).toThrow(/each binding once/);
  });

  it("rejects bindings equal to the command's defaults", () => {
    expect(() => new Keymap({ "editor.save": ["Meta+s"] })).toThrow(/differ from the command's defaults/);
  });

  it("falls back to the defaults and matches the pressed shortcut", () => {
    const keymap = Keymap.defaults();
    expect(textsOf(keymap, "editor.back")).toEqual(["Meta+[", "Alt+Meta+ArrowLeft"]);
    expect(keymap.matches(press("ArrowLeft", "ArrowLeft", { metaKey: true, altKey: true }), "editor.back")).toBe(true);
    expect(keymap.matches(press("[", "BracketLeft", { metaKey: true, shiftKey: true }), "editor.back")).toBe(false);
    expect(keymap.matches(press("Meta", "MetaLeft", { metaKey: true }), "editor.back")).toBe(false);
  });

  it("follows the user's bindings, which may be empty", () => {
    const keymap = Keymap.defaults().with("editor.closeTab", shortcuts("Ctrl+w"));
    expect(keymap.matches(press("w", "KeyW", { ctrlKey: true }), "editor.closeTab")).toBe(true);
    expect(keymap.matches(press("w", "KeyW", { metaKey: true }), "editor.closeTab")).toBe(false);
    expect(keymap.isDefaultBinding("editor.closeTab")).toBe(false);
    expect(textsOf(Keymap.defaults().with("editor.closeTab", []), "editor.closeTab")).toEqual([]);
  });

  it("drops the user's bindings once they equal the defaults again", () => {
    const keymap = Keymap.defaults().with("editor.save", shortcuts("Meta+d")).with("editor.save", shortcuts("Meta+s", "Meta+s"));
    expect(keymap.toJSON()).toEqual({});
    expect(keymap.isDefault).toBe(true);
    expect(keymap.isDefaultBinding("editor.save")).toBe(true);
    expect(keymap.isEqualTo(Keymap.defaults())).toBe(true);
  });

  it("picks the first command of a list that the press is bound to", () => {
    const commandIds = ["editor.moveTabLeft", "editor.moveTabUp"] as const;
    expect(Keymap.defaults().commandFor(press("E", "KeyE", { metaKey: true, shiftKey: true }), commandIds)).toBe("editor.moveTabUp");
    expect(Keymap.defaults().commandFor(press("x", "KeyX", { metaKey: true }), commandIds)).toBeNull();
  });

  it("labels a command with its first binding, or with nothing while it is unbound", () => {
    expect(Keymap.defaults().labelOf("editor.findInFiles")).toBe("⇧⌘F");
    expect(Keymap.defaults().with("editor.findInFiles", shortcuts("Ctrl+f", "Meta+f")).labelOf("editor.findInFiles")).toBe("⌃F");
    expect(Keymap.defaults().with("editor.findInFiles", []).labelOf("editor.findInFiles")).toBeNull();
  });

  it("lists the default bindings of a command", () => {
    expect(Keymap.defaultBindingsOf("chat.sendNow").map((shortcut) => shortcut.text)).toEqual(["Ctrl+Enter", "Meta+Enter"]);
  });

  it("finds the commands of the same scope with a shared binding", () => {
    const keymap = Keymap.defaults().with("editor.save", shortcuts("Meta+e"));
    expect(keymap.conflictsOf("editor.save")).toEqual(["editor.moveTabLeft"]);
    expect(keymap.conflictsOf("editor.moveTabLeft")).toEqual(["editor.save"]);
  });

  it("ignores commands of another scope when looking for conflicts", () => {
    expect(Keymap.defaults().conflictsOf("session.remove")).toEqual([]);
    expect(Keymap.defaults().conflictsOf("editor.closeTab")).toEqual([]);
  });

  it("has defaults without conflicts that every command can take", () => {
    for (const command of KEYMAP_COMMANDS) {
      expect(Keymap.defaults().conflictsOf(command.id)).toEqual([]);
      expect(Keymap.defaultBindingsOf(command.id).map((shortcut) => shortcut.text)).toEqual(command.defaults);
      for (const shortcut of Keymap.defaultBindingsOf(command.id)) {
        expect(shortcut.bindingProblem).toBeNull();
      }
    }
  });

  it("reads a stored keymap without unknown commands, malformed lists, invalid shortcuts and default bindings", () => {
    const stored = { "editor.save": ["Meta+d", 3, "e", ""], "editor.closeTab": "Meta+w", "chat.cycleMode": ["Shift+Tab"], "gone.command": ["Meta+g"] };
    expect(Keymap.fromStored(stored).toJSON()).toEqual({ "editor.save": ["Meta+d"] });
    expect(Keymap.fromStored(null).isDefault).toBe(true);
    expect(Keymap.fromStored(["Meta+d"]).isDefault).toBe(true);
  });

  it("serializes to the stored form it reads back unchanged", () => {
    const json = '{"editor.closeTab":[],"editor.save":["Meta+d","Ctrl+s"]}';
    const keymap = Keymap.fromStored(JSON.parse(json));
    expect(JSON.stringify(keymap)).toBe(json);
    expect(Keymap.fromStored(JSON.parse(JSON.stringify(keymap))).isEqualTo(keymap)).toBe(true);
  });
});
