import * as monaco from "monaco-editor";
import { reviewBarLeft } from "./addCommentGlyph";

let zoneCounter = 0;

/**
 * Interactive DOM under a line of the editor, like Monaco's own zone widgets: a view zone reserves the space and
 * scrolls with the text, an overlay widget holds `domNode`, as the editor's lines layer would cover the zone's own
 * node. The zone's height follows the rendered height of `domNode`; `--zone-bar-left` on it is the x of the review
 * bar (see `reviewBarLeft`), for content that continues the bar or aligns with it.
 */
export class LineZone implements monaco.editor.IOverlayWidget {
  readonly domNode: HTMLDivElement;
  private readonly id = `hunt.lineZone.${zoneCounter++}`;
  private readonly zone: monaco.editor.IViewZone;
  private zoneId: string | null = null;
  private readonly observer: ResizeObserver;
  private readonly disposables: monaco.IDisposable[] = [];

  private isEditorDisposed = false;

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    /** The line the zone sits under. */
    readonly afterLine: number,
    /**
     * Order among zones under the same line, lower first; keep it below 10000, Monaco's default, which the inline
     * diff's deleted-lines zone uses: a later zone shifts the hidden original editor's base line numbers below it.
     */
    ordinal: number,
  ) {
    this.domNode = document.createElement("div");
    this.domNode.className = "hunt-review-zone";
    // Stops Monaco from moving its caret or starting a selection on a press inside the zone; Monaco listens on an ancestor.
    this.domNode.addEventListener("mousedown", (event) => event.stopPropagation());
    // Monaco hides a zone when the line after `afterLine` is collapsed, which is the case under the last context line
    // of every hunk; a comment there must still show.
    this.zone = {
      afterLineNumber: afterLine,
      ordinal,
      showInHiddenAreas: true,
      heightInPx: 0,
      domNode: document.createElement("div"),
      onDomNodeTop: (top) => {
        this.domNode.style.top = `${top}px`;
        this.domNode.style.visibility = "visible";
      },
    };
    editor.addOverlayWidget(this);
    this.layout();
    editor.changeViewZones((accessor) => {
      this.zoneId = accessor.addZone(this.zone);
    });
    this.observer = new ResizeObserver(() => this.relayoutZone());
    this.observer.observe(this.domNode);
    this.disposables.push(
      editor.onDidLayoutChange(() => this.layout()),
      editor.onDidDispose(() => {
        this.isEditorDisposed = true;
      }),
    );
  }

  getId(): string {
    return this.id;
  }

  getDomNode(): HTMLElement {
    return this.domNode;
  }

  /** The node is placed by `onDomNodeTop` and `layout`, not by Monaco. */
  getPosition(): monaco.editor.IOverlayWidgetPosition | null {
    return null;
  }

  dispose(): void {
    this.observer.disconnect();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    if (this.isEditorDisposed) return;
    this.editor.changeViewZones((accessor) => {
      if (this.zoneId) {
        accessor.removeZone(this.zoneId);
      }
    });
    this.editor.removeOverlayWidget(this);
  }

  private layout(): void {
    const layoutInfo = this.editor.getLayoutInfo();
    this.domNode.style.left = "0px";
    this.domNode.style.width = `${layoutInfo.width - layoutInfo.verticalScrollbarWidth}px`;
    this.domNode.style.setProperty("--zone-bar-left", `${reviewBarLeft(layoutInfo)}px`);
  }

  private relayoutZone(): void {
    const height = this.domNode.offsetHeight;
    if (height === this.zone.heightInPx || !this.zoneId || this.isEditorDisposed) return;
    this.zone.heightInPx = height;
    this.editor.changeViewZones((accessor) => {
      if (this.zoneId) {
        accessor.layoutZone(this.zoneId);
      }
    });
  }
}
