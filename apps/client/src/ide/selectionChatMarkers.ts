import * as monaco from "monaco-editor";
import { describeSelection } from "../chat/SelectionCard";
import type { SelectionChat } from "./selectionChats";

const GLYPH_CLASS = "hunt-chat-glyph";
/** Added to the button while the chat's agent is running a turn; the glow pulses. */
const BUSY_CLASS = "hunt-chat-glyph-busy";
/** Set on the editor's container while the line decorations column holds chat buttons; moves the fold chevrons right of them. */
const HAS_GLYPHS_CLASS = "hunt-has-chat-glyphs";
/** Width the chat buttons add to the line decorations column, right of the change stripe zone: the button and a gap. */
const GLYPHS_WIDTH = 30;

function toDecoration(chat: SelectionChat, isBusy: boolean): monaco.editor.IModelDeltaDecoration {
  const line = chat.selection.startLine;
  return {
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: {
      linesDecorationsClassName: isBusy ? `${GLYPH_CLASS} ${BUSY_CLASS}` : GLYPH_CLASS,
      linesDecorationsTooltip: `Sub chat about ${describeSelection(chat.selection)}`,
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  };
}

/**
 * Sub chat buttons in the gutter right of the line numbers: one on the first line of every selection of the shown
 * file a sub chat was opened from (see selectionChats.ts). The line decorations column widens to hold them while
 * the shown file has any and returns to the editor's own width otherwise. A button pulses while its chat's agent
 * is working. A click on a button reports its chat and never reaches Monaco, whose folding takes every click in the
 * column as one on the fold chevron.
 */
export class SelectionChatMarkers {
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly domNode: HTMLElement;
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly clickListeners = new Set<(chat: SelectionChat) => void>();
  private readonly plainDecorationsWidth: number;
  private path: string | null = null;
  private chats: SelectionChat[] = [];
  private busyChatIds: ReadonlySet<string> = new Set();
  private signature = "";

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    /** Worktree path of a model, or null for models that are not worktree files. */
    private readonly pathOf: (model: monaco.editor.ITextModel) => string | null,
  ) {
    this.decorations = editor.createDecorationsCollection();
    this.plainDecorationsWidth = editor.getOption(monaco.editor.EditorOption.lineDecorationsWidth);
    this.domNode = editor.getContainerDomNode();
    this.domNode.addEventListener("mousedown", this.onDomMouseDown, true);
    this.disposables.push(editor.onDidChangeModel(() => this.apply()));
  }

  /**
   * Shows `chats`, which belong to the file at `path`; the buttons only appear while that file's model is shown.
   * `busyChatIds` are the chats whose agent is running a turn (see `useBusyChatIds`).
   */
  set(path: string | null, chats: SelectionChat[], busyChatIds: ReadonlySet<string>): void {
    const signature = `${path}\n${chats.map((chat) => `${chat.sessionId}:${chat.selection.startLine}:${busyChatIds.has(chat.sessionId)}`).join("\n")}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.path = path;
    this.chats = chats;
    this.busyChatIds = busyChatIds;
    this.apply();
  }

  onDidClickChat(listener: (chat: SelectionChat) => void): monaco.IDisposable {
    this.clickListeners.add(listener);
    return { dispose: () => this.clickListeners.delete(listener) };
  }

  dispose(): void {
    this.domNode.removeEventListener("mousedown", this.onDomMouseDown, true);
    this.domNode.classList.remove(HAS_GLYPHS_CLASS);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.decorations.clear();
    this.editor.updateOptions({ lineDecorationsWidth: this.plainDecorationsWidth });
    this.clickListeners.clear();
  }

  private apply(): void {
    const model = this.editor.getModel();
    const isShown = model !== null && this.path !== null && this.pathOf(model) === this.path;
    const shown = isShown ? this.chats : [];
    this.decorations.set(shown.map((chat) => toDecoration(chat, this.busyChatIds.has(chat.sessionId))));
    this.domNode.classList.toggle(HAS_GLYPHS_CLASS, shown.length > 0);
    const width = shown.length ? this.plainDecorationsWidth + GLYPHS_WIDTH : this.plainDecorationsWidth;
    if (this.editor.getOption(monaco.editor.EditorOption.lineDecorationsWidth) !== width) {
      this.editor.updateOptions({ lineDecorationsWidth: width });
    }
  }

  private readonly onDomMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest(`.${GLYPH_CLASS}`)) return;
    event.preventDefault();
    event.stopPropagation();
    const line = this.editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position?.lineNumber;
    const chat = this.chats.find((candidate) => candidate.selection.startLine === line);
    if (!chat) return;
    for (const listener of this.clickListeners) {
      listener(chat);
    }
  };
}
