import * as monaco from "monaco-editor";
import { describeSelection } from "../chat/SelectionCard";
import type { SelectionChat } from "./selectionChats";

function toDecoration(chat: SelectionChat): monaco.editor.IModelDeltaDecoration {
  const line = chat.selection.startLine;
  return {
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: {
      glyphMarginClassName: "hunt-chat-glyph",
      glyphMarginHoverMessage: { value: `Sub chat about ${describeSelection(chat.selection)}` },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

/**
 * Sub chat glyphs in the gutter left of the line numbers: one on the first line of every selection of the shown
 * file a sub chat was opened from (see selectionChats.ts). A click on a glyph reports its chat.
 */
export class SelectionChatMarkers {
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly clickListeners = new Set<(chat: SelectionChat) => void>();
  private path: string | null = null;
  private chats: SelectionChat[] = [];
  private signature = "";

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    /** Worktree path of a model, or null for models that are not worktree files. */
    private readonly pathOf: (model: monaco.editor.ITextModel) => string | null,
  ) {
    this.decorations = editor.createDecorationsCollection();
    this.disposables.push(
      editor.onDidChangeModel(() => this.apply()),
      editor.onMouseDown((event) => this.onMouseDown(event)),
    );
  }

  /** Shows `chats`, which belong to the file at `path`; the glyphs only appear while that file's model is shown. */
  set(path: string | null, chats: SelectionChat[]): void {
    const signature = `${path}\n${chats.map((chat) => `${chat.sessionId}:${chat.selection.startLine}`).join("\n")}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.path = path;
    this.chats = chats;
    this.apply();
  }

  onDidClickChat(listener: (chat: SelectionChat) => void): monaco.IDisposable {
    this.clickListeners.add(listener);
    return { dispose: () => this.clickListeners.delete(listener) };
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.decorations.clear();
    this.clickListeners.clear();
  }

  private apply(): void {
    const model = this.editor.getModel();
    const isShown = model !== null && this.path !== null && this.pathOf(model) === this.path;
    this.decorations.set(isShown ? this.chats.map(toDecoration) : []);
  }

  private onMouseDown(event: monaco.editor.IEditorMouseEvent): void {
    const { target } = event;
    if (target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !target.position) return;
    const line = target.position.lineNumber;
    const chat = this.chats.find((candidate) => candidate.selection.startLine === line);
    if (!chat) return;
    for (const listener of this.clickListeners) {
      listener(chat);
    }
  }
}
