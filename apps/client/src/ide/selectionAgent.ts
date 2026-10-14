import * as monaco from "monaco-editor";
import { readSelectionRequest, type SelectionRequest } from "../diff/selectionContext";
import { SelectionAskButton } from "./selectionAskButton";

export type SelectionAgentHandlers = {
  /** Worktree path of a model, or null for models that are not worktree files. */
  pathOf: (model: monaco.editor.ITextModel) => string | null;
  /** Opens the sub chat popover for the selection ("Ask Claude about selection" in the context menu). */
  onOpen: (request: SelectionRequest) => void;
  /** Opens or closes the sub chat popover for the selection (the floating button at the selection's active end). */
  onToggle: (request: SelectionRequest) => void;
};

/**
 * Gives `editor` the agent features every code view shares: the "Ask Claude about selection" context menu entry
 * and the floating button that appears at the active end of a selection (see selectionAskButton.ts). Handlers are
 * read at call time, so they may close over changing props through a ref.
 */
export function attachSelectionAgent(editor: monaco.editor.IStandaloneCodeEditor, handlers: SelectionAgentHandlers): monaco.IDisposable {
  const action = editor.addAction({
    id: "hunt.askAboutSelection",
    label: "Ask Claude about selection",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 0,
    precondition: "editorHasSelection",
    run: (current) => {
      const model = current.getModel();
      const path = model ? handlers.pathOf(model) : null;
      const request = path ? readSelectionRequest(current, path) : null;
      if (request) {
        handlers.onOpen(request);
      }
    },
  });
  const button = new SelectionAskButton(editor, handlers.pathOf);
  const click = button.onDidClick((request) => handlers.onToggle(request));
  return {
    dispose: () => {
      click.dispose();
      button.dispose();
      action.dispose();
    },
  };
}
