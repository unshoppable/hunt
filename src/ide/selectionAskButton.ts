import * as monaco from "monaco-editor";
import { readSelectionRequest, type SelectionRequest } from "../diff/selectionContext";
import { askButtonPlacement } from "./askButtonPlacement";

const WIDGET_ID = "hunt.selectionAskButton";

/**
 * Floating "Ask Claude" button next to the active end of the selection, i.e. where the mouse was released or the
 * keyboard selection stopped. It appears once the mouse button is up and the selection holds text, stays while the
 * editor is unfocused (so it can close the popover it opened), and disappears when the selection collapses or the
 * model changes. A click reports the same selection request as "Ask Claude about selection" in the context menu.
 */
export class SelectionAskButton implements monaco.editor.IContentWidget {
  readonly allowEditorOverflow = true;
  readonly suppressMouseDown = true;
  private readonly domNode: HTMLDivElement;
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly clickListeners = new Set<(request: SelectionRequest) => void>();
  private position: monaco.editor.IContentWidgetPosition | null = null;
  private isPointerDown = false;

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    /** Worktree path of a model, or null for models that are not worktree files. */
    private readonly pathOf: (model: monaco.editor.ITextModel) => string | null,
  ) {
    this.domNode = document.createElement("div");
    this.domNode.className = "hunt-ask-button";
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Ask Claude about selection";
    button.setAttribute("aria-label", "Ask Claude about selection");
    this.domNode.appendChild(button);
    // The press must neither move the caret nor collapse the selection; Monaco listens on an ancestor.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", () => this.report());

    const onWindowMouseUp = () => {
      this.isPointerDown = false;
      this.update();
    };
    window.addEventListener("mouseup", onWindowMouseUp, true);
    this.disposables.push(
      { dispose: () => window.removeEventListener("mouseup", onWindowMouseUp, true) },
      editor.onMouseDown(() => {
        this.isPointerDown = true;
        this.hide();
      }),
      editor.onDidChangeCursorSelection(() => this.update()),
      editor.onDidChangeModel(() => this.update()),
      editor.onDidChangeModelContent(() => this.update()),
    );
    editor.addContentWidget(this);
  }

  onDidClick(listener: (request: SelectionRequest) => void): monaco.IDisposable {
    this.clickListeners.add(listener);
    return { dispose: () => this.clickListeners.delete(listener) };
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.editor.removeContentWidget(this);
    this.clickListeners.clear();
  }

  getId(): string {
    return WIDGET_ID;
  }

  getDomNode(): HTMLElement {
    return this.domNode;
  }

  getPosition(): monaco.editor.IContentWidgetPosition | null {
    return this.position;
  }

  private hide(): void {
    if (!this.position) return;
    this.position = null;
    this.editor.layoutContentWidget(this);
  }

  private update(): void {
    const selection = this.editor.getSelection();
    const model = this.editor.getModel();
    const hasText = !!selection && !!model && !selection.isEmpty() && !!model.getValueInRange(selection).trim();
    if (!selection || !model || !hasText || this.isPointerDown || !this.pathOf(model)) {
      this.hide();
      return;
    }
    const active = selection.getPosition();
    const isForward = selection.getDirection() === monaco.SelectionDirection.LTR;
    const placement = askButtonPlacement(isForward, this.editor.getOffsetForColumn(active.lineNumber, active.column));
    this.domNode.className = `hunt-ask-button hunt-ask-button--${placement}`;
    this.domNode.style.height = `${this.editor.getOption(monaco.editor.EditorOption.lineHeight)}px`;
    const { EXACT, ABOVE, BELOW } = monaco.editor.ContentWidgetPositionPreference;
    this.position = { position: active, preference: placement === "above" ? [ABOVE, BELOW] : [EXACT] };
    this.editor.layoutContentWidget(this);
  }

  private report(): void {
    const model = this.editor.getModel();
    const path = model ? this.pathOf(model) : null;
    const request = path ? readSelectionRequest(this.editor, path) : null;
    if (!request) return;
    for (const listener of this.clickListeners) {
      listener(request);
    }
  }
}
