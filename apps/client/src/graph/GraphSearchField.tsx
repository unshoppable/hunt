import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { ICON_BUTTON_XS } from "../ui/buttons.constants";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "../ui/Icons";
import { MATCH_KIND_RANK, type MatchKind } from "./graph-search.utils";
import type { DiagramFlowNode } from "./layout.utils";

/**
 * The ⌘F field of the dependency diagram, floating in the canvas' top-right corner. The diagram highlights every file
 * in `matches` (see graph-search.utils.ts) and the view moves to the active one: to the first match while the active one
 * stops matching or a better kind of match turns up, to the next with Enter or ↓, to the previous with ⇧Enter or ↑.
 * Matches are visited by kind (name, path, symbol), each kind from top to bottom, left to right. Escape closes the field.
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
  matches: ReadonlyMap<string, MatchKind> | null;
  activePath: string | null;
  minZoom: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
  onActivePathChange: (path: string | null) => void;
  onClose: () => void;
}) {
  const { getInternalNode, getZoom, setCenter } = useReactFlow<DiagramFlowNode>();

  /** The matching files by kind, then from top to bottom, left to right. */
  const ordered = useMemo(() => {
    const placed = [...(matches ?? [])].flatMap(([path, kind]) => {
      const node = getInternalNode(path);
      return node ? [{ path, rank: MATCH_KIND_RANK[kind], position: node.internals.positionAbsolute }] : [];
    });
    placed.sort((left, right) => left.rank - right.rank || left.position.y - right.position.y || left.position.x - right.position.x);
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
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  useEffect(() => {
    const activeKind = activePathRef.current ? matchesRef.current?.get(activePathRef.current) : undefined;
    if (activeKind && activeKind === matchesRef.current?.get(ordered[0])) return;
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
