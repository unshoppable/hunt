/**
 * The commands of the keymap: every keyboard shortcut Hunt handles itself, with its default bindings as canonical
 * shortcut texts (see `Shortcut`). `Keymap` layers the user's bindings over them.
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
  { id: "app.toggleSessions", label: "Show or hide the session list", group: "General", scope: "app", defaults: ["Meta+1"] },
  { id: "app.toggleChat", label: "Show or hide the chat", group: "General", scope: "app", defaults: ["Meta+2"] },
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
  {
    id: "changes.copyPath",
    label: "Copy the selected file's absolute path",
    group: "Changes",
    scope: "app",
    defaults: ["Ctrl+Shift+c"],
    note: "in the change list, the editor's project tree and, for the open file, the editor",
  },
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
  {
    id: "editor.deleteInTree",
    label: "Delete the selected files and folders",
    group: "Editor",
    scope: "app",
    defaults: ["Meta+Backspace"],
    note: "in the editor's project tree, after asking",
  },
  { id: "editor.closeTab", label: "Close tab", group: "Editor", scope: "app", defaults: ["Meta+w"] },
  { id: "editor.closeAllTabs", label: "Close all tabs", group: "Editor", scope: "app", defaults: ["Shift+Meta+w"] },
  { id: "editor.moveTabLeft", label: "Move tab to the pane on the left", group: "Editor", scope: "app", defaults: ["Meta+e"] },
  { id: "editor.moveTabRight", label: "Move tab to the pane on the right", group: "Editor", scope: "app", defaults: ["Meta+r"] },
  { id: "editor.moveTabUp", label: "Move tab to the pane above", group: "Editor", scope: "app", defaults: ["Shift+Meta+e"] },
  { id: "editor.moveTabDown", label: "Move tab to the pane below", group: "Editor", scope: "app", defaults: ["Shift+Meta+r"] },
  { id: "graph.find", label: "Find files by name or symbol in the dependency diagram", group: "Architecture", scope: "app", defaults: ["Meta+f"] },
] as const satisfies readonly KeymapCommand[];

export type CommandId = (typeof KEYMAP_COMMANDS)[number]["id"];
