import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Commit } from "../ipc/types";
import { useSettingsStore, type GitLogColumns } from "../state/settings";
import { trackDrag } from "../ui/pointerDrag";
import type { LogFilter } from "./GitPanel";
import { layoutGraph, type GraphRow } from "./commitGraph";
import { BranchIcon, TagIcon } from "../ui/icons";
import { logLabels, type LogLabel } from "./logLabels";

/** Horizontal distance between two lanes of the graph, in px. */
const LANE_WIDTH = 14;
/** Space left of the first lane and right of the last, in px. */
const GRAPH_PADDING = 10;
/** The most lanes the graph column grows to; wider graphs are clipped at the right. */
const MAX_LANES = 12;
/** Rows drawn above and below the visible ones, so a scroll never shows an empty strip. */
const OVERSCAN = 8;
/** Width of the push marker column at the right edge, in px. */
const MARKER_WIDTH = 32;
/** Narrowest the author and date columns can be dragged to, in px. */
const MIN_COLUMN_WIDTH = 48;
/** Widest the author and date columns can be dragged to, in px. */
const MAX_COLUMN_WIDTH = { author: 480, date: 240 };
/** Line colors of the graph, one per lane in turn. */
const LANE_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb923c", "#2dd4bf", "#f87171"];

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * The commit log: a filter row and the commits as windowed rows (only the visible ones are in the DOM), each with its
 * graph cell, subject, compact branch and tag labels, author and date in fixed columns whose borders drag to resize
 * them (the widths persist in the settings). Scrolling near the end asks for the next page; ↑ and ↓ move the selection
 * while the list has the focus.
 */
export function CommitLog({
  commits,
  head,
  localBranches,
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
  /** The checked-out branch; its tip's label is marked. */
  head: string | null;
  /** Names of the local branches, so a slashed name in a commit's decorations is told from a remote branch. */
  localBranches: ReadonlySet<string>;
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
  const storedColumns = useSettingsStore((state) => state.gitLogColumns);
  const setStoredColumns = useSettingsStore((state) => state.setGitLogColumns);
  /** The column whose left border is being dragged and the widths meanwhile; the settings hold them otherwise. */
  const [drag, setDrag] = useState<{ column: keyof GitLogColumns; columns: GitLogColumns } | null>(null);
  const columns = drag?.columns ?? storedColumns;
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

  /** Starts dragging the border left of `column`: the column keeps its right edge, so its width follows the pointer the other way. */
  const dragBorder = (event: ReactPointerEvent<HTMLElement>, column: keyof GitLogColumns) => {
    const start = storedColumns;
    let next = start;
    trackDrag(
      event,
      (dx) => {
        const width = Math.min(MAX_COLUMN_WIDTH[column], Math.max(MIN_COLUMN_WIDTH, start[column] - dx));
        // The author|date border moves the author column's right edge too, so the author keeps its left edge.
        next = column === "date" ? { author: Math.max(MIN_COLUMN_WIDTH, start.author + start.date - width), date: width } : { ...start, author: width };
        setDrag({ column, columns: next });
      },
      () => {
        setDrag(null);
        setStoredColumns(next);
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--changelist-bg)">
      <div className="flex items-center gap-2 border-b border-(--line) px-3 py-2.5 text-[13px] text-neutral-400">
        <FilterInput value={filter.text} onApply={(text) => onFilterChange({ ...filter, text })} placeholder="Text or hash" title="Show only commits whose message contains this text, or the commit with this hash" className="min-w-0 flex-1" />
        <span className="shrink-0 tabular-nums">
          {commits.length}
          {hasMore ? "+" : ""} {commits.length === 1 ? "commit" : "commits"}
        </span>
      </div>
      {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] whitespace-pre-wrap text-red-400">{error}</p> : null}
      <div className="relative flex min-h-0 flex-1">
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
                localBranches={localBranches}
                columns={columns}
                isUnpushed={unpushed.has(commit.id)}
                isSelected={commit.id === selectedId}
                onSelect={() => onSelect(commit.id)}
              />
            );
          })}
        </div>
      </div>
      <ColumnBorder right={MARKER_WIDTH + columns.date + columns.author} isDragging={drag?.column === "author"} onPointerDown={(event) => dragBorder(event, "author")} />
      <ColumnBorder right={MARKER_WIDTH + columns.date} isDragging={drag?.column === "date"} onPointerDown={(event) => dragBorder(event, "date")} />
      </div>
    </div>
  );
}

/** The draggable border left of a column, `right` px from the list's right edge, spanning the list's height. */
function ColumnBorder({ right, isDragging, onPointerDown }: { right: number; isDragging: boolean; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      style={{ right: right - 3 }}
      className={`group absolute inset-y-0 z-10 w-[7px] cursor-col-resize ${isDragging ? "" : "hover:bg-white/5"}`}
      title="Drag to resize the column"
    >
      <div className={`absolute inset-y-0 left-[3px] w-px ${isDragging ? "bg-blue-400/60" : "bg-transparent group-hover:bg-white/15"}`} />
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
  localBranches,
  columns,
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
  localBranches: ReadonlySet<string>;
  columns: GitLogColumns;
  isUnpushed: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const labels = logLabels(commit.refs, head, localBranches);
  return (
    <div
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
      style={{ top, height }}
      className={`absolute right-0 left-0 flex cursor-default items-center select-none ${isSelected ? "bg-(--tree-selection)" : "hover:bg-(--row-hover)"}`}
    >
      <GraphCell row={row} width={graphWidth} height={height} />
      <span className="flex min-w-0 flex-1 items-center gap-2 pr-2">
        <span className={`min-w-0 truncate ${isUnpushed ? "text-neutral-100" : "text-neutral-300"}`} title={commit.subject}>
          {commit.subject}
        </span>
        {labels.length ? (
          <span className="ml-auto flex max-w-[50%] shrink-0 items-center gap-1">
            {labels.map((label) => (
              <LogLabelChip key={`${label.kind}:${label.text}`} label={label} />
            ))}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 truncate px-2 text-neutral-400" style={{ width: columns.author }} title={`${commit.author} <${commit.authorEmail}>`}>
        {commit.author}
      </span>
      <span className="shrink-0 truncate px-2 text-right text-neutral-500 tabular-nums" style={{ width: columns.date }}>
        {DATE_FORMAT.format(new Date(commit.authoredAt))}
      </span>
      <span className="flex shrink-0 justify-center text-amber-300" style={{ width: MARKER_WIDTH }} title={isUnpushed ? "Not pushed yet" : undefined}>
        {isUnpushed ? <UpArrowIcon /> : null}
      </span>
    </div>
  );
}

const LABEL_CLASS: Record<LogLabel["kind"] | "head", string> = {
  head: "bg-blue-400/20 text-blue-100",
  branch: "bg-white/8 text-neutral-300",
  more: "bg-white/8 text-neutral-400",
  tags: "bg-amber-400/12 text-amber-200",
};

/** One compact label at the right end of a log row: a branch with its icon, the collapsed rest, or the tags. */
function LogLabelChip({ label }: { label: LogLabel }) {
  const kind = label.kind === "branch" && label.isHead ? "head" : label.kind;
  return (
    <span className={`flex min-w-0 items-center gap-1 rounded px-1.5 text-[0.85em] leading-[1.6] ${LABEL_CLASS[kind]}`} title={label.title}>
      {label.kind === "branch" ? <BranchIcon className="size-3 shrink-0 opacity-70" /> : label.kind === "tags" ? <TagIcon className="size-3 shrink-0 opacity-70" /> : null}
      <span className="truncate">{label.text}</span>
    </span>
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
