import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Commit } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import type { LogFilter } from "./GitPanel";
import { layoutGraph, type GraphRow } from "./commitGraph";
import { RefChip, parseDecoration } from "./RefChip";

/** Horizontal distance between two lanes of the graph, in px. */
const LANE_WIDTH = 14;
/** Space left of the first lane and right of the last, in px. */
const GRAPH_PADDING = 10;
/** The most lanes the graph column grows to; wider graphs are clipped at the right. */
const MAX_LANES = 12;
/** Rows drawn above and below the visible ones, so a scroll never shows an empty strip. */
const OVERSCAN = 8;
/** Line colors of the graph, one per lane in turn. */
const LANE_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb923c", "#2dd4bf", "#f87171"];

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * The commit log: a filter row and the commits as windowed rows (only the visible ones are in the DOM), each with its
 * graph cell, its branch and tag chips, subject, author and date. Scrolling near the end asks for the next page;
 * ↑ and ↓ move the selection while the list has the focus.
 */
export function CommitLog({
  commits,
  head,
  unpushed,
  filter,
  onFilterChange,
  selectedId,
  onSelect,
  hasMore,
  isLoading,
  onLoadMore,
  error,
}: {
  commits: Commit[];
  /** The checked-out branch; its tip's chip is marked. */
  head: string | null;
  /** Commits a push would publish. */
  unpushed: Set<string>;
  filter: LogFilter;
  onFilterChange: (filter: LogFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  error: string | null;
}) {
  const fontSize = useSettingsStore((state) => state.panes.changelist.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.changelist.lineHeight);
  const rowHeight = Math.round(fontSize * lineHeight);
  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const laneCount = useMemo(() => Math.min(MAX_LANES, Math.max(1, ...rows.map((row) => row.laneCount))), [rows]);
  const graphWidth = GRAPH_PADDING * 2 + (laneCount - 1) * LANE_WIDTH;
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    setViewportHeight(list.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(list.clientHeight));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const firstIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const lastIndex = Math.min(commits.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN);

  // The next page loads once the view is within a screen of the end.
  useEffect(() => {
    if (!hasMore || isLoading || !viewportHeight) return;
    if (scrollTop + viewportHeight * 2 >= commits.length * rowHeight) {
      onLoadMore();
    }
  }, [scrollTop, viewportHeight, commits.length, rowHeight, hasMore, isLoading, onLoadMore]);

  const selectedIndex = selectedId ? commits.findIndex((commit) => commit.id === selectedId) : -1;

  const scrollIntoView = (index: number) => {
    const list = listRef.current;
    if (!list) return;
    const top = index * rowHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (top + rowHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + rowHeight - list.clientHeight;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = Math.min(commits.length - 1, Math.max(0, selectedIndex + (event.key === "ArrowDown" ? 1 : -1)));
    const commit = commits[next];
    if (!commit) return;
    onSelect(commit.id);
    scrollIntoView(next);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--changelist-bg)">
      <div className="flex items-center gap-2 border-b border-(--line) px-3 py-2.5 text-[13px] text-neutral-400">
        <FilterInput value={filter.reference} onApply={(reference) => onFilterChange({ ...filter, reference })} placeholder="Branch or tag" title="Show only the history of this branch or tag; empty shows every branch and tag" className="w-44 shrink-0" />
        <FilterInput value={filter.text} onApply={(text) => onFilterChange({ ...filter, text })} placeholder="Text or hash" title="Show only commits whose message contains this text, or the commit with this hash" className="min-w-0 flex-1" />
        <span className="shrink-0 tabular-nums">
          {commits.length}
          {hasMore ? "+" : ""} {commits.length === 1 ? "commit" : "commits"}
        </span>
      </div>
      {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
      <div
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="Commits"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        className="relative min-h-0 flex-1 overflow-auto outline-none font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-400/60"
      >
        {commits.length === 0 && !isLoading ? <p className="p-3 text-[13px] text-neutral-500">{filter.text || filter.reference ? "No commits match the filter." : "No commits."}</p> : null}
        <div style={{ height: commits.length * rowHeight }}>
          {commits.slice(firstIndex, lastIndex).map((commit, offset) => {
            const index = firstIndex + offset;
            return (
              <LogRow
                key={commit.id}
                commit={commit}
                row={rows[index]}
                top={index * rowHeight}
                height={rowHeight}
                graphWidth={graphWidth}
                head={head}
                isUnpushed={unpushed.has(commit.id)}
                isSelected={commit.id === selectedId}
                onSelect={() => onSelect(commit.id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LogRow({
  commit,
  row,
  top,
  height,
  graphWidth,
  head,
  isUnpushed,
  isSelected,
  onSelect,
}: {
  commit: Commit;
  row: GraphRow;
  top: number;
  height: number;
  graphWidth: number;
  head: string | null;
  isUnpushed: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
      title={isUnpushed ? "Not pushed yet" : undefined}
      style={{ top, height }}
      className={`absolute right-0 left-0 flex cursor-default items-center gap-2 pr-3 select-none ${isSelected ? "bg-(--tree-selection)" : "hover:bg-(--row-hover)"}`}
    >
      <GraphCell row={row} width={graphWidth} height={height} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {commit.refs.map((decoration) => {
          const chip = parseDecoration(decoration);
          return <RefChip key={decoration} chip={chip} isHead={chip.kind === "head" || chip.name === head} />;
        })}
        <span className={`truncate ${isUnpushed ? "text-neutral-100" : "text-neutral-300"}`}>{commit.subject}</span>
      </span>
      <span className="w-36 shrink-0 truncate text-neutral-400" title={`${commit.author} <${commit.authorEmail}>`}>
        {commit.author}
      </span>
      <span className="w-28 shrink-0 text-right text-neutral-500 tabular-nums">{DATE_FORMAT.format(new Date(commit.authoredAt))}</span>
      <span className="flex w-4 shrink-0 justify-center text-amber-300">{isUnpushed ? <UpArrowIcon /> : null}</span>
    </div>
  );
}

/** The graph cell of one row: the lane lines passing it, the lines joining and leaving its node, and the node. */
function GraphCell({ row, width, height }: { row: GraphRow; width: number; height: number }) {
  const x = (lane: number) => GRAPH_PADDING + lane * LANE_WIDTH;
  const middle = height / 2;
  const nodeX = x(row.lane);
  return (
    <svg width={width} height={height} className="shrink-0 overflow-hidden" aria-hidden="true">
      {row.segments.map((segment, index) => {
        const color = LANE_COLORS[segment.color % LANE_COLORS.length];
        if (segment.kind === "through") {
          return <path key={index} d={`M${x(segment.lane)} 0V${height}`} stroke={color} strokeWidth={2} fill="none" />;
        }
        if (segment.kind === "in") {
          const from = x(segment.from);
          const d = from === nodeX ? `M${from} 0V${middle}` : `M${from} 0C${from} ${middle} ${nodeX} 0 ${nodeX} ${middle}`;
          return <path key={index} d={d} stroke={color} strokeWidth={2} fill="none" />;
        }
        const to = x(segment.to);
        const d = to === nodeX ? `M${nodeX} ${middle}V${height}` : `M${nodeX} ${middle}C${nodeX} ${height} ${to} ${middle} ${to} ${height}`;
        return <path key={index} d={d} stroke={color} strokeWidth={2} fill="none" />;
      })}
      <circle cx={nodeX} cy={middle} r={4} fill={LANE_COLORS[row.color % LANE_COLORS.length]} stroke="var(--changelist-bg)" strokeWidth={1.5} />
    </svg>
  );
}

/** A text filter that applies on Enter or when the field is left; Escape restores the applied value, a second Escape leaves the field. */
function FilterInput({ value, onApply, placeholder, title, className }: { value: string; onApply: (value: string) => void; placeholder: string; title: string; className: string }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      placeholder={placeholder}
      title={title}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onApply(draft.trim());
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (draft !== value) {
            setDraft(value);
          } else {
            event.currentTarget.blur();
          }
        }
      }}
      className={`h-7 rounded-md border border-white/10 bg-(--surface-input) px-2 text-[13px] text-neutral-200 outline-none placeholder:text-neutral-500 focus:border-white/20 ${className}`}
    />
  );
}

function UpArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  );
}
