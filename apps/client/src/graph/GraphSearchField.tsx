import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { ICON_BUTTON_XS } from "../ui/buttons";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "../ui/icons";
import type { DiagramFlowNode } from "./layout";

/**
 * The ⌘F field of the dependency diagram, floating in the canvas' top-right corner. The diagram highlights every file
 * in `matches` (see graphSearch.ts) and the view moves to the active one: to the topmost match while the active one
 * stops matching, to the next with Enter or ↓, to the previous with ⇧Enter or ↑. Escape closes the field.
 * `minZoom` is the zoom the view comes in to at least, so the file's name is readable.
 */
export function GraphSearchField({
  query,
  matches,
  activePath,
  minZoom,
  inputRef,
  onQueryChange,
  onActivePathChange,
  onClose,
}: {
  query: string;
  matches: ReadonlySet<string> | null;
  activePath: string | null;
  minZoom: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
  onActivePathChange: (path: string | null) => void;
  onClose: () => void;
}) {
  const { getInternalNode, getZoom, setCenter } = useReactFlow<DiagramFlowNode>();

  /** The matching files from top to bottom, left to right. */
  const ordered = useMemo(() => {
    const placed = [...(matches ?? [])].flatMap((path) => {
      const node = getInternalNode(path);
      return node ? [{ path, position: node.internals.positionAbsolute }] : [];
    });
    placed.sort((left, right) => left.position.y - right.position.y || left.position.x - right.position.x);
    return placed.map((entry) => entry.path);
  }, [matches, getInternalNode]);

  const goTo = (path: string) => {
    onActivePathChange(path);
    const node = getInternalNode(path);
    if (!node) return;
    const width = node.measured.width ?? node.width ?? 0;
    const height = node.measured.height ?? node.height ?? 0;
    const { x, y } = node.internals.positionAbsolute;
    void setCenter(x + width / 2, y + height / 2, { zoom: Math.max(getZoom(), minZoom), duration: 200 });
  };
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  useEffect(() => {
    if (activePathRef.current && ordered.includes(activePathRef.current)) return;
    if (ordered.length) {
      goToRef.current(ordered[0]);
    } else {
      onActivePathChange(null);
    }
  }, [ordered, onActivePathChange]);

  const step = (direction: 1 | -1) => {
    if (!ordered.length) return;
    const index = activePath ? ordered.indexOf(activePath) : -1;
    const next = index < 0 ? (direction > 0 ? 0 : ordered.length - 1) : (index + direction + ordered.length) % ordered.length;
    goTo(ordered[next]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const activeIndex = activePath ? ordered.indexOf(activePath) : -1;
  const count = !query.trim() ? null : ordered.length ? `${activeIndex + 1}/${ordered.length}` : "No match";

  return (
    <div className="absolute top-3 right-3 z-20 flex h-9 items-center gap-1 rounded-md border border-(--line) bg-(--surface-input) p-1 pl-2.5 text-[13px] shadow-lg shadow-black/30">
      <SearchIcon className="size-3.5 shrink-0 text-neutral-500" />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find file or symbol"
        aria-label="Find a file of the diagram by its path or a symbol in it"
        spellCheck={false}
        className="w-56 bg-transparent text-neutral-100 outline-none placeholder:text-neutral-500"
      />
      {count ? <span className={`shrink-0 px-1 text-[12px] tabular-nums ${ordered.length ? "text-neutral-400" : "text-amber-300/90"}`}>{count}</span> : null}
      <button type="button" onClick={() => step(-1)} disabled={!ordered.length} className={ICON_BUTTON_XS} aria-label="Previous match" title="Previous match (⇧⏎)">
        <ChevronDownIcon className="size-3.5 rotate-180" />
      </button>
      <button type="button" onClick={() => step(1)} disabled={!ordered.length} className={ICON_BUTTON_XS} aria-label="Next match" title="Next match (⏎)">
        <ChevronDownIcon className="size-3.5" />
      </button>
      <button type="button" onClick={onClose} className={ICON_BUTTON_XS} aria-label="Close the search" title="Close (Esc)">
        <CloseIcon className="size-3.5" />
      </button>
    </div>
  );
}
