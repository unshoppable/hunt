import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath, type EdgeProps, type NodeProps } from "@xyflow/react";
import { useFileIconUrl, useFolderIconUrl } from "../diff/fileIcons";
import { STATUS_NAME_CLASS } from "../diff/styles";
import { CommentIcon } from "../ui/icons";
import { HoverTooltip } from "../ui/HoverTooltip";
import { baseName } from "../ui/path";
import type { DiagramNode, ShortPath } from "./diagram";
import type { MatchKind } from "./graphSearch";
import { ReviewBars } from "./ReviewBars";
import type { DependencyEdge, FileNode, FolderGroupNode } from "./layout";
import { EDGE_COLOR, EDGE_COLOR_HIGHLIGHTED, LABEL_HEIGHT, MAX_LABEL_WIDTH, orthogonalPath } from "./layout";

/** Invisible handle where the layout attaches an edge to a node; shared by every diagram node. */
export const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

/** Review comments per file path (see `useReviewCommentCounts`), counted in the bottom-right corner of each file box. */
export const CommentCountsContext = createContext<Map<string, number>>(new Map());

/** The files the ⌘F search matches and the one the view moved to; null while the search is closed. */
export type SearchHighlight = { matches: ReadonlyMap<string, MatchKind>; activePath: string | null };
export const SearchHighlightContext = createContext<SearchHighlight | null>(null);

/**
 * One file: icon, name colored by git status and directory below the name; the line counts and review bars sit in the top-right corner,
 * the count of review comments in the bottom-right one, which also lightens the border. Context files without changes are
 * dashed and dimmed. A file the search matches gets a blue border, the active match a blue ring as well.
 */
export function FileNodeView({ data, selected }: NodeProps<FileNode>) {
  const fileIconUrl = useFileIconUrl();
  const commentCount = useContext(CommentCountsContext).get(data.path) ?? 0;
  const searchHighlight = useContext(SearchHighlightContext);
  const borderStyle = data.isChanged ? "" : "border-dashed";
  const frame = selected
    ? "border-white/60 shadow-[0_0_0_3px_rgba(255,255,255,0.12)]"
    : searchHighlight?.activePath === data.path
      ? `${borderStyle} border-blue-400 shadow-[0_0_0_4px_rgba(96,165,250,0.4)]`
      : searchHighlight?.matches.has(data.path)
        ? `${borderStyle} border-blue-400/80`
        : data.isChanged
          ? commentCount ? "border-white/40" : "border-white/25"
          : `border-dashed opacity-45 ${commentCount ? "border-white/25" : "border-(--line)"}`;

  return (
    <div className={`relative flex h-full w-full items-stretch overflow-hidden rounded-lg border bg-(--surface-inset) text-neutral-100 transition-shadow ${frame}`}>
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <CornerStats data={data} className="absolute top-2 right-3" />
      <CommentCount count={commentCount} className="absolute right-3 bottom-2" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <img src={fileIconUrl(data.path)} alt="" className="size-4 shrink-0" />
          <span className={`truncate text-[13px] font-medium ${data.isChanged ? (STATUS_NAME_CLASS[data.status ?? ""] ?? "text-neutral-100") : "text-neutral-200"}`}>{data.name}</span>
          <span className="flex-1" />
          <CornerStats data={data} className="invisible" isGhost />
        </div>
        <div className="flex items-center gap-1.5">
          <HoverTooltip text={data.directory} className="flex min-w-0">
            <DirectoryLabel short={data.shortDirectory} className="text-[12px] text-neutral-500" />
          </HoverTooltip>
          <span className="flex-1" />
          <CommentCount count={commentCount} className="invisible" isGhost />
        </div>
      </div>
    </div>
  );
}

/**
 * Review comments of a file as a speech bubble with their count, pinned to the bottom-right corner of the box; nothing
 * while there are none. The directory row renders an invisible copy (`isGhost`) so the directory truncates before it.
 */
function CommentCount({ count, className, isGhost = false }: { count: number; className: string; isGhost?: boolean }) {
  if (!count) return null;
  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-[13px] text-neutral-400 tabular-nums ${className}`}
      title={isGhost ? undefined : `${count} review ${count === 1 ? "comment" : "comments"}`}
      aria-hidden={isGhost}
    >
      <CommentIcon className="size-4" />
      {/* Lifted to the middle of the bubble, which sits above its tail. */}
      <span className="relative -top-px">{count}</span>
    </span>
  );
}

/**
 * Line counts and review bars of a changed file, pinned to the top-right corner of the box. The name row renders an
 * invisible copy (`isGhost`) so the file name truncates before it would run underneath the visible one.
 */
function CornerStats({ data, className, isGhost = false }: { data: DiagramNode; className: string; isGhost?: boolean }) {
  if (!data.isChanged && !data.review) return null;
  return (
    <span className={`flex items-center gap-1.5 ${className}`} aria-hidden={isGhost}>
      {data.isChanged ? <ChangeBadge added={data.added} removed={data.removed} /> : null}
      {data.review ? <ReviewBars level={data.review} reason={data.reviewReason} /> : null}
    </span>
  );
}

/** Border, horizontal padding, icon and the gaps around the file name in `FileNodeView`'s name row, in px. */
const NAME_ROW_CHROME = 2 * 1 + 2 * 12 + 16 + 2 * 6;
/** `gap-1.5` before the corner stats and between their badge and review bars, `gap-1` inside the badge. */
const STATS_GAP = 6;
const BADGE_GAP = 4;
/** `size-3.5` of the review bars. */
const REVIEW_BARS_WIDTH = 14;

/**
 * Smallest box width at which `FileNodeView` shows the file name of `node` in full next to its corner stats. Mirrors
 * the name row's markup, so a change there has to be made here as well.
 */
export function fileNodeMinWidth(node: DiagramNode): number {
  const rootStyle = getComputedStyle(document.documentElement);
  const sans = rootStyle.fontFamily;
  const mono = rootStyle.getPropertyValue("--font-mono") || "monospace";
  let width = NAME_ROW_CHROME + textWidth(node.name, `500 13px ${sans}`);
  if (!node.isChanged && !node.review) return width;
  width += STATS_GAP;
  if (node.isChanged && !node.added && !node.removed) {
    width += textWidth("binary", `12px ${sans}`);
  } else if (node.isChanged) {
    const counts = [node.added ? `+${node.added}` : "", node.removed ? `−${node.removed}` : ""].filter(Boolean);
    width += counts.reduce((sum, count) => sum + textWidth(count, `12px ${mono}`), 0) + (counts.length - 1) * BADGE_GAP;
  }
  if (node.review) {
    width += (node.isChanged ? STATS_GAP : 0) + REVIEW_BARS_WIDTH;
  }
  return width;
}

let measureContext: CanvasRenderingContext2D | null = null;

/** Rendered width of `text` in the CSS font shorthand `font`, measured on a shared canvas. */
function textWidth(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return 0;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * Translucent area behind the files of one folder, labeled with the folder's module and short path in its top-left
 * corner; only the label catches the mouse, to show the full path. The edges run behind the area; the label sits on
 * an opaque copy of the area's tint, so an edge stops at the label instead of crossing its icon and text.
 */
export function FolderGroupView({ data }: NodeProps<FolderGroupNode>) {
  const folderIconUrl = useFolderIconUrl();
  return (
    <div className="pointer-events-none h-full w-full rounded-xl border border-white/8 bg-white/[0.035]">
      <div className="px-2 pt-2">
        <HoverTooltip
          text={data.directory}
          className="pointer-events-auto flex w-fit max-w-full items-center gap-1.5 rounded-md bg-(--xy-background-color) bg-linear-to-b from-white/[0.035] to-white/[0.035] px-1 py-0.5 text-[12px] text-neutral-500"
        >
          <img src={folderIconUrl(data.directory)} alt="" className="size-3.5 opacity-70" />
          <DirectoryLabel short={data.shortDirectory} />
          <span className="text-neutral-600">{data.nodePaths.length}</span>
        </HoverTooltip>
      </div>
    </div>
  );
}

/**
 * A one-line directory label with its module name set off as a chip; the root directory reads `.`. Shows every folder
 * while they fit the width of the diagram node around it and the short form with `…` otherwise, re-checked whenever
 * the node is resized.
 */
export function DirectoryLabel({ short, className = "" }: { short: ShortPath; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [nodeWidth, setNodeWidth] = useState(0);
  const [elidedFor, setElidedFor] = useState<string | null>(null);
  const fitKey = `${short.full}@${nodeWidth}`;
  const isElided = elidedFor === fitKey;
  const folders = isElided ? short.rest : short.full;

  useLayoutEffect(() => {
    const node = ref.current?.closest(".react-flow__node");
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setNodeWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const label = ref.current;
    if (isElided || !label || label.scrollWidth <= label.clientWidth) return;
    setElidedFor(fitKey);
  }, [fitKey, isElided]);

  return (
    <span ref={ref} className={`truncate font-mono ${className}`}>
      {short.alias ? <AliasChip alias={short.alias} /> : null}
      {short.alias ? (folders ? `/${folders}` : null) : folders || "."}
    </span>
  );
}

/** A module name, styled the same in the directory labels and the legend. */
export function AliasChip({ alias }: { alias: string }) {
  return <span className="rounded-sm bg-white/10 px-1 text-neutral-300">{alias}</span>;
}

/** `+added −removed` of a changed file; a side with no lines is left out. */
export function ChangeBadge({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return <span className="shrink-0 text-[12px] text-neutral-500">binary</span>;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[12px] tabular-nums">
      {added ? <span className="text-emerald-300">+{added}</span> : null}
      {removed ? <span className="text-red-300">−{removed}</span> : null}
    </span>
  );
}

/** Gap between the label box and the description popover above it. */
const POPOVER_GAP = 6;
/** Opacity of an edge while another edge or file is hovered. */
const MUTED_OPACITY = 0.3;
/** Dash pattern of an edge that points at an unchanged context file, matching the file's dashed border. */
const CONTEXT_EDGE_DASH = "5 4";

/**
 * A dependency on ELK's orthogonal route with its label centered on the box ELK reserved on it. The edge is
 * `selected` while it or its source file is hovered and is then drawn brighter with a boxed label; while something
 * else is hovered it fades, so the lit edges stand out. An edge to an unchanged context file is dashed. At rest the label is plain text on a backdrop that keeps the
 * line from running through it; a faded label fades only its text, so the backdrop stays opaque. Its description floats above the label only while the mouse is on the edge or
 * its label, so one popover shows at a time; a hovered file lists its dependencies in the `DependencyCard` instead.
 */
export function DependencyEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, selected }: EdgeProps<DependencyEdge>) {
  const [isLabelHovered, setIsLabelHovered] = useState(false);
  const points = data?.points ?? [];
  const [fallbackPath, fallbackX, fallbackY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 });
  const path = points.length >= 2 ? orthogonalPath(points) : fallbackPath;
  const labelCenter = data?.labelCenter ?? { x: fallbackX, y: fallbackY };
  const isHighlighted = Boolean(selected) || isLabelHovered;
  const isMuted = Boolean(data?.isMuted) && !isHighlighted;
  const showsDescription = Boolean(data?.isHovered) || isLabelHovered;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: isHighlighted ? EDGE_COLOR_HIGHLIGHTED : EDGE_COLOR,
          strokeWidth: isHighlighted ? 1.8 : 1.2,
          strokeDasharray: data?.isToContext ? CONTEXT_EDGE_DASH : undefined,
          opacity: isMuted ? MUTED_OPACITY : 1,
          transition: "opacity 150ms",
        }}
      />
      {data?.label ? (
        <EdgeLabelRenderer>
          <div
            data-edge-id={id}
            title={data.label}
            onMouseEnter={() => setIsLabelHovered(true)}
            onMouseLeave={() => setIsLabelHovered(false)}
            style={{ transform: `translate(-50%, -50%) translate(${labelCenter.x}px, ${labelCenter.y}px)`, maxWidth: MAX_LABEL_WIDTH }}
            className={`nodrag nopan pointer-events-auto absolute truncate rounded-md border px-2 py-[3px] text-[12px] leading-[18px] transition-colors duration-150 ${
              isHighlighted ? "border-white/30 bg-(--surface-inset) text-neutral-100" : `border-transparent bg-(--surface-chat) ${isMuted ? "text-neutral-400/30" : "text-neutral-400"}`
            }`}
          >
            {data.label}
          </div>
          {showsDescription && data.description ? (
            <div
              style={{ transform: `translate(-50%, -100%) translate(${labelCenter.x}px, ${labelCenter.y - LABEL_HEIGHT / 2 - POPOVER_GAP}px)`, zIndex: 10 }}
              className="pointer-events-none absolute w-max max-w-[360px] rounded-md border border-white/15 bg-(--surface-inset) px-2.5 py-1.5 text-[13px] leading-snug text-neutral-200 shadow-lg shadow-black/40"
            >
              <div className="mb-0.5 truncate font-mono text-[12px] text-neutral-500">
                {baseName(source)} → {baseName(target)}
              </div>
              {data.description}
            </div>
          ) : null}
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
