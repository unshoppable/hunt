import * as monaco from "monaco-editor";

/** Class on the word under the cursor while Cmd is held; styled in index.css (underline, highlight, pointer). */
const LINK_CLASS = "hunt-ide-link";

export type IdeLinkHandlers = {
  /** ⌘click: navigation inside the app (go to declaration, open in the built-in editor). */
  onNavigate?: (line: number, column: number) => void;
  /** ⇧⌘click: open the position in WebStorm. */
  onOpenInIde: (line: number, column: number) => void;
};

/**
 * Wires ⌘click and ⇧⌘click to the handlers and, while Cmd is held, marks the hovered word as a link so the
 * editor reads as clickable before the click. The hover decoration follows the mouse and disappears when Cmd is
 * released or the mouse leaves the editor. Returns a disposable that removes the listeners and the decoration.
 */
export function attachIdeLink(editor: monaco.editor.ICodeEditor, handlers: IdeLinkHandlers): monaco.IDisposable {
  const decorations = editor.createDecorationsCollection();
  let hovered: monaco.Position | null = null;

  const render = (isMetaHeld: boolean) => {
    const model = editor.getModel();
    const word = isMetaHeld && hovered && model ? model.getWordAtPosition(hovered) : null;
    if (!word || !hovered) {
      decorations.clear();
      return;
    }
    decorations.set([
      {
        range: new monaco.Range(hovered.lineNumber, word.startColumn, hovered.lineNumber, word.endColumn),
        options: { inlineClassName: LINK_CLASS },
      },
    ]);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Meta") return;
    render(event.type === "keydown");
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  // A Cmd release outside the window (e.g. after an app switch) never fires keyup; focus loss clears it instead.
  const onBlur = () => render(false);
  window.addEventListener("blur", onBlur);

  const subscriptions = [
    editor.onMouseMove((event) => {
      hovered = event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT ? event.target.position : null;
      render(event.event.metaKey);
    }),
    editor.onMouseLeave(() => {
      hovered = null;
      render(false);
    }),
    editor.onMouseDown((event) => {
      const position = event.target.position;
      if (!event.event.metaKey || !event.event.leftButton || !position) return;
      if (event.event.shiftKey) {
        handlers.onOpenInIde(position.lineNumber, position.column);
      } else {
        handlers.onNavigate?.(position.lineNumber, position.column);
      }
    }),
  ];

  return {
    dispose: () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      decorations.clear();
    },
  };
}
