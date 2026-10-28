import type * as monaco from "monaco-editor";
import type { CommandId } from "../common/keymap/keymap-commands.data";
import { isShortcut, shortcutLabel } from "../ui/shortcuts.utils";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IKeybindingService, type ResolvedKeybinding } from "monaco-editor/platform/keybinding/common/keybinding.js";

/**
 * Runs `run` when a binding of the keymap command `id` is pressed while `editor` has the focus. The binding is read at
 * press time, so a keymap change reaches open editors at once, and the press does not reach Monaco's own bindings.
 */
export function onShortcut(editor: monaco.editor.ICodeEditor, id: CommandId, run: () => void): monaco.IDisposable {
  return editor.onKeyDown((event) => {
    if (!isShortcut(event.browserEvent, id)) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  });
}

/** Keymap command of each action added through `addKeymapAction`, by the action's id. */
const keymapActions = new Map<string, CommandId>();
let showsKeymapBindings = false;

/**
 * Adds an action to `editor`'s context menu and Monaco's command palette that also runs on the bindings of the keymap
 * command `id` (see `onShortcut`); both show the command's first binding beside the label, read when they open. The
 * shortcut ignores the action's `precondition`, so `run` checks what it needs itself.
 */
export function addKeymapAction(editor: monaco.editor.IStandaloneCodeEditor, id: CommandId, action: Omit<monaco.editor.IActionDescriptor, "keybindings" | "run"> & { run: () => void }): monaco.IDisposable {
  showKeymapBindings();
  keymapActions.set(action.id, id);
  const added = editor.addAction({ ...action, run: () => action.run() });
  const shortcut = onShortcut(editor, id, action.run);
  return {
    dispose: () => {
      shortcut.dispose();
      added.dispose();
    },
  };
}

/**
 * Makes Monaco's context menu and command palette show the keymap binding of the actions added by `addKeymapAction`:
 * they ask the keybinding service for the command `<editor id>:<action id>`, which has no Monaco keybinding.
 */
function showKeymapBindings(): void {
  if (showsKeymapBindings) return;
  showsKeymapBindings = true;
  const service = StandaloneServices.get(IKeybindingService);
  const lookup = service.lookupKeybinding.bind(service);
  service.lookupKeybinding = (commandId, ...rest) => {
    const command = keymapActions.get(commandId.slice(commandId.lastIndexOf(":") + 1));
    if (!command) return lookup(commandId, ...rest);
    const label = shortcutLabel(command);
    return label ? labelKeybinding(label) : undefined;
  };
}

/** A keybinding Monaco draws as `label` (`⌘Ü`) and never dispatches; Hunt's keymap handles the press. */
function labelKeybinding(label: string): ResolvedKeybinding {
  const chord = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, keyLabel: label, keyAriaLabel: label };
  return {
    getLabel: () => label,
    getAriaLabel: () => label,
    getElectronAccelerator: () => null,
    getUserSettingsLabel: () => null,
    isWYSIWYG: () => true,
    hasMultipleChords: () => false,
    getChords: () => [chord],
    getDispatchChords: () => [null],
    getSingleModifierDispatchChords: () => [null],
  };
}
