import { createContext, useContext, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath, type EdgeProps, type NodeProps } from "@xyflow/react";
import { folderIconUrl, useFileIconUrl } from "../diff/fileIcons";
import { STATUS_NAME_CLASS } from "../diff/styles";
import { baseName } from "../ui/path";
import type { ReviewLevel } from "../ipc/types";
import type { DiagramNode, ShortPath } from "./diagram";
import type { DependencyEdge, FileNode, FolderGroupNode } from "./layout";
import { EDGE_COLOR, EDGE_COLOR_HIGHLIGHTED, LABEL_HEIGHT, MAX_LABEL_WIDTH, orthogonalPath } from "./layout";

/** What a file does when activated: show its diff in the overlay or open it in the editor window. */
export type GraphActions = {
  openDiff: (node: DiagramNode) => void;
  openFile: (node: DiagramNode) => void;
};

export const GraphActionsContext = createContext<GraphActions>({ openDiff: () => {}, openFile: () => {} });

const HANDLE_STYLE = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

/** Nodes at least this tall have room for the description below the path. */
const DESCRIPTION_MIN_HEIGHT = 92;

/**
 * One file: icon, name colored by git status, directory (left out inside a folder group, whose label names it) and,
 * on taller boxes, the agent's description; the line counts and review bars sit in the top-right corner, the editor
 * button appears in the bottom-right corner on hover. Context files without changes are dashed and dimmed.
 */
export function FileNodeView({ data, selected }: NodeProps<FileNode>) {
  const fileIconUrl = useFileIconUrl();
  const actions = useContext(GraphActionsContext);
  const showDescription = Boolean(data.description) && data.height >= DESCRIPTION_MIN_HEIGHT;

  return (
    <div
      className={`group relative flex h-full w-full items-stretch overflow-hidden rounded-lg border bg-(--surface-inset) text-neutral-100 transition-shadow ${
        selected ? "border-white/60 shadow-[0_0_0_3px_rgba(255,255,255,0.12)]" : data.isChanged ? "border-white/25" : "border-dashed border-(--line) opacity-45"
      }`}
    >
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <CornerStats data={data} className="absolute top-2 right-3" />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <img src={fileIconUrl(data.path)} alt="" className="size-4 shrink-0" />
          <span className={`truncate text-[13px] font-medium ${data.isChanged ? (STATUS_NAME_CLASS[data.status ?? ""] ?? "text-neutral-100") : "text-neutral-200"}`}>{data.name}</span>
          <span className="flex-1" />
          <CornerStats data={data} className="invisible" isGhost />
        </div>
        {data.shortDirectory ? (
          <span className="truncate font-mono text-[12px] text-neutral-500">
            <DirectoryLabel short={data.shortDirectory} />
          </span>
        ) : null}
        {showDescription ? <span className="line-clamp-2 text-[12px] leading-snug text-neutral-400">{data.description}</span> : null}
      </div>
      <button
        type="button"
        title={`Open ${data.path} in the editor`}
        onClick={(event) => {
          event.stopPropagation();
          actions.openFile(data);
        }}
        className="nodrag absolute right-1 bottom-1 flex size-6 items-center justify-center rounded-md border border-(--line) bg-(--surface-inset) text-neutral-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-(--row-hover) hover:text-white"
      >
        <OpenIcon />
      </button>
    </div>
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

/** Translucent area behind the files of one folder, labeled with the folder path in its top-left corner. */
export function FolderGroupView({ data }: NodeProps<FolderGroupNode>) {
  return (
    <div className="pointer-events-none h-full w-full rounded-xl border border-white/8 bg-white/[0.035]" title={data.directory}>
      <div className="flex items-center gap-1.5 px-3 pt-2.5 text-[12px] text-neutral-500">
        <img src={folderIconUrl(baseName(data.directory))} alt="" className="size-3.5 opacity-70" />
        <span className="truncate font-mono">
          <DirectoryLabel short={data.shortDirectory} />
        </span>
        <span className="text-neutral-600">{data.nodePaths.length}</span>
      </div>
    </div>
  );
}

/** A directory with its legend alias set off as a chip; the root directory reads `.`. */
export function DirectoryLabel({ short }: { short: ShortPath }) {
  if (!short.alias) return <>{short.rest || "."}</>;
  return (
    <>
      <AliasChip alias={short.alias} />
      {short.rest ? `/${short.rest}` : null}
    </>
  );
}

/** The legend term that stands for a path prefix, styled the same in the file labels and the legend. */
export function AliasChip({ alias }: { alias: string }) {
  return <span className="rounded-sm bg-white/10 px-1 text-neutral-300">{alias}</span>;
}

/** Bar color per review level: red for files that need little review up to green for those that need a close look. */
const REVIEW_COLORS: Record<ReviewLevel, string> = { 1: "#f87171", 2: "#fb923c", 3: "#facc15", 4: "#4ade80" };

/** What each review level means, for tooltips and the legend. */
export const REVIEW_LABELS: Record<ReviewLevel, string> = { 1: "little review needed", 2: "some review", 3: "review recommended", 4: "needs close review" };

/**
 * The agent's review rating as a signal-strength icon: four bars rising from left to right, of which `level` are lit
 * in the level's color, red for 1 up to green for 4. The tooltip states the level and the agent's reason.
 */
export function ReviewBars({ level, reason, className = "size-3.5" }: { level: ReviewLevel; reason?: string; className?: string }) {
  const title = `Review ${level}/4: ${REVIEW_LABELS[level]}${reason ? ` — ${reason}` : ""}`;
  return (
    <svg viewBox="0 0 15 12" className={`${className} shrink-0`} role="img" aria-label={title}>
      <title>{title}</title>
      {[0, 1, 2, 3].map((bar) => (
        <rect key={bar} x={bar * 4} y={9 - bar * 3} width="3" height={3 + bar * 3} rx="0.75" fill={bar < level ? REVIEW_COLORS[level] : "rgba(255,255,255,0.14)"} />
      ))}
    </svg>
  );
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
/** Opacity of an edge and its label while another edge or file is hovered. */
const MUTED_OPACITY = 0.3;

/**
 * A dependency on ELK's orthogonal route with its label centered on the box ELK reserved on it. The edge is
 * `selected` while it or its source file is hovered and is then drawn brighter with a boxed label; while something
 * else is hovered it fades, so the lit edges stand out. At rest the label is plain text on a backdrop that keeps the
 * line from running through it. Its description floats above the label only while the mouse is on the edge or
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
        style={{ stroke: isHighlighted ? EDGE_COLOR_HIGHLIGHTED : EDGE_COLOR, strokeWidth: isHighlighted ? 1.8 : 1.2, opacity: isMuted ? MUTED_OPACITY : 1, transition: "opacity 150ms" }}
      />
      {data?.label ? (
        <EdgeLabelRenderer>
          <div
            data-edge-id={id}
            title={data.label}
            onMouseEnter={() => setIsLabelHovered(true)}
            onMouseLeave={() => setIsLabelHovered(false)}
            style={{ transform: `translate(-50%, -50%) translate(${labelCenter.x}px, ${labelCenter.y}px)`, maxWidth: MAX_LABEL_WIDTH, opacity: isMuted ? MUTED_OPACITY : 1 }}
            className={`nodrag nopan pointer-events-auto absolute truncate rounded-md border px-2 py-[3px] text-[12px] leading-[18px] transition-opacity duration-150 ${
              isHighlighted ? "border-white/30 bg-(--surface-inset) text-neutral-100" : "border-transparent bg-(--surface-chat) text-neutral-400"
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

function OpenIcon() {
  return (
    <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 2h3v3M10 2 5.5 6.5M8.5 7v2.5h-6v-6H5" />
    </svg>
  );
}
