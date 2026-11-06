import { useEffect, type ReactNode, type RefObject } from "react";
import type { ShapeDiagramType } from "../../common/diagram/diagram.types";
import type { ShapeKind } from "./shape-diagram.types";
import { ICON_BUTTON_BASE_SM, SECONDARY_BUTTON_LG } from "../../ui/buttons.constants";
import { isRemoteInput, withShortcut } from "../../ui/shortcuts.utils";
import { kindName } from "./ShapeElementEditor";

/** What a click on the canvas does: select and drag (`select`), connect two elements (`connect`) or place an element of that kind. */
export type ShapeTool = "select" | "connect" | ShapeKind;

/**
 * Fixed keys of the tools, like the keys of a dialog outside the keymap (which binds no key that types text): they count
 * only while the focus is on the canvas or nowhere. The element tools take 1–9 in the order the toolbar lists them.
 */
const SELECT_KEY = "v";
const CONNECT_KEY = "a";
const BOUNDARY_KEY = "b";
const MAX_ELEMENT_TOOLS = 9;

type ShapeToolbarProps = {
  diagramType: ShapeDiagramType;
  /** The element kinds the diagram type allows, each a tool (`KINDS_BY_TYPE`, at most nine). */
  kinds: ShapeKind[];
  tool: ShapeTool;
  onToolChange: (tool: ShapeTool) => void;
  /** Adds a boundary at once, since a boundary encloses its elements instead of sitting where it is placed; absent where the type has none. */
  onAddBoundary?: () => void;
  /** Drops the positions set by hand; absent while there are none. */
  onAutoLayout?: () => void;
  isDisabled: boolean;
  /** The canvas whose keys pick the tools while the focus is on it or nowhere. */
  canvasRef: RefObject<HTMLDivElement | null>;
};

/**
 * The tools of an editable shape diagram, floating at the bottom of the canvas: select, connect (not in an ERD), one
 * per element kind and the boundary, each with its shortcut in the corner. An element tool places its kind where the
 * canvas is clicked next; Escape, V or a second click on the active tool return to select.
 */
export function ShapeToolbar({ diagramType, kinds, tool, onToolChange, onAddBoundary, onAutoLayout, isDisabled, canvasRef }: ShapeToolbarProps) {
  const isErd = diagramType === "erd";
  const elementKinds = kinds.slice(0, MAX_ELEMENT_TOOLS);

  // Tool keys count while the focus is on the canvas or nowhere, never while typing in a field.
  useEffect(() => {
    if (isDisabled) return;
    const isOnCanvas = (target: EventTarget | null) =>
      !isRemoteInput(target) && (target === document.body || (target instanceof Node && Boolean(canvasRef.current?.contains(target))));
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !isOnCanvas(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === BOUNDARY_KEY) {
        if (!onAddBoundary) return;
        event.preventDefault();
        onAddBoundary();
        return;
      }
      const next: ShapeTool | undefined = key === SELECT_KEY ? "select" : key === CONNECT_KEY && !isErd ? "connect" : /^[1-9]$/.test(key) ? kinds[Number(key) - 1] : undefined;
      if (!next) return;
      event.preventDefault();
      onToolChange(next);
    }
    // Escape takes the active tool back to select in the capture phase, so it does not interrupt the agent's turn too.
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || tool === "select" || !isOnCanvas(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onToolChange("select");
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [isDisabled, isErd, kinds, tool, onToolChange, onAddBoundary, canvasRef]);

  const pick = (next: ShapeTool) => onToolChange(tool === next ? "select" : next);

  return (
    <div role="toolbar" aria-label="Diagram tools" className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-white/15 bg-(--surface-input) p-1 shadow-xl shadow-black/50">
      <ToolButton title="Select and move" shortcut={SELECT_KEY} isActive={tool === "select"} isDisabled={isDisabled} onClick={() => onToolChange("select")}>
        <PointerIcon />
      </ToolButton>
      {isErd ? null : (
        <ToolButton title="Connect two elements: click the one it starts at, then the one it ends at" shortcut={CONNECT_KEY} isActive={tool === "connect"} isDisabled={isDisabled} onClick={() => pick("connect")}>
          <ConnectIcon />
        </ToolButton>
      )}
      <Separator />
      {elementKinds.map((kind, position) => (
        <ToolButton
          key={kind}
          title={`${kindName(diagramType, kind)}: click the canvas to place it`}
          shortcut={String(position + 1)}
          isActive={tool === kind}
          isDisabled={isDisabled}
          onClick={() => pick(kind)}
        >
          <KindIcon kind={kind} />
        </ToolButton>
      ))}
      {onAddBoundary ? (
        <ToolButton title="Add a boundary; pick its elements in their editors" shortcut={BOUNDARY_KEY} isActive={false} isDisabled={isDisabled} onClick={onAddBoundary}>
          <BoundaryIcon />
        </ToolButton>
      ) : null}
      {onAutoLayout ? (
        <>
          <Separator />
          <button type="button" onClick={onAutoLayout} title="Drop the positions and connection courses set by hand and lay the diagram out automatically" className={SECONDARY_BUTTON_LG}>
            Auto-layout
          </button>
        </>
      ) : null}
    </div>
  );
}

function Separator() {
  return <div role="separator" aria-orientation="vertical" className="mx-0.5 h-5 border-l border-white/15" />;
}

/** A square tool button with its shortcut in the bottom-right corner; the active tool shows pressed. */
function ToolButton({ title, shortcut, isActive, isDisabled, onClick, children }: { title: string; shortcut: string; isActive: boolean; isDisabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={withShortcut(title, shortcut.toUpperCase())}
      aria-label={title}
      aria-pressed={isActive}
      disabled={isDisabled}
      onClick={onClick}
      className={`relative ${ICON_BUTTON_BASE_SM} ${isActive ? "bg-(--row-active) text-white" : "text-neutral-300 hover:bg-(--row-hover) hover:text-white"}`}
    >
      {children}
      <span className="absolute right-0.5 bottom-0 text-[9px] leading-3 text-neutral-500">{shortcut.toUpperCase()}</span>
    </button>
  );
}

function ToolIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function PointerIcon() {
  return (
    <ToolIcon>
      <path d="M3.5 2.5 12.5 7.6 8.4 8.6 6.6 12.8Z" />
    </ToolIcon>
  );
}

function ConnectIcon() {
  return (
    <ToolIcon>
      <path d="M2.5 13.5 13 3M8.5 3H13v4.5" />
    </ToolIcon>
  );
}

function BoundaryIcon() {
  return (
    <ToolIcon>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" strokeDasharray="2 1.6" />
      <rect x="4.5" y="6" width="7" height="4.5" rx="0.8" />
    </ToolIcon>
  );
}

/** The outline each element kind is drawn with on the canvas, small. */
function KindIcon({ kind }: { kind: ShapeKind }) {
  switch (kind) {
    case "person":
      return (
        <ToolIcon>
          <circle cx="8" cy="5" r="2.5" />
          <path d="M3 14a5 5 0 0 1 10 0" />
        </ToolIcon>
      );
    case "system":
      return (
        <ToolIcon>
          <rect x="1.5" y="3.5" width="13" height="9" rx="1.2" fill="currentColor" fillOpacity="0.25" />
        </ToolIcon>
      );
    case "container":
      return (
        <ToolIcon>
          <rect x="1.5" y="3.5" width="13" height="9" rx="1.2" />
          <path d="M1.5 6.5h13" />
        </ToolIcon>
      );
    case "externalSystem":
      return (
        <ToolIcon>
          <rect x="1.5" y="3.5" width="13" height="9" rx="1.2" strokeDasharray="2 1.6" />
        </ToolIcon>
      );
    case "state":
      return (
        <ToolIcon>
          <rect x="1.5" y="3.5" width="13" height="9" rx="3.5" />
        </ToolIcon>
      );
    case "database":
      return (
        <ToolIcon>
          <ellipse cx="8" cy="4" rx="5" ry="1.8" />
          <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4" />
        </ToolIcon>
      );
    case "queue":
      return (
        <ToolIcon>
          <path d="M3.5 4.5h9M3.5 11.5h9M3.5 4.5a1.5 3.5 0 0 0 0 7" />
          <ellipse cx="12.5" cy="8" rx="1.5" ry="3.5" />
        </ToolIcon>
      );
    case "decision":
      return (
        <ToolIcon>
          <path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" />
        </ToolIcon>
      );
    case "start":
      return (
        <ToolIcon>
          <circle cx="8" cy="8" r="4.5" fill="currentColor" />
        </ToolIcon>
      );
    case "end":
      return (
        <ToolIcon>
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="2.8" fill="currentColor" />
        </ToolIcon>
      );
    case "table":
      return (
        <ToolIcon>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M2 6.5h12M6.5 6.5V13" />
        </ToolIcon>
      );
    default:
      return (
        <ToolIcon>
          <rect x="1.5" y="3.5" width="13" height="9" rx="1.2" />
        </ToolIcon>
      );
  }
}
