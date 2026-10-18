import { memo, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getSmoothStepPath, type EdgeProps, type EdgeTypes, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { ShapeChange, ShapeKind, TableColumn } from "../ipc/types";
import { EDGE_COLOR, EDGE_COLOR_HIGHLIGHTED, LABEL_HEIGHT, MAX_LABEL_WIDTH, orthogonalPath, pathMidpoint } from "./layout";
import { HANDLE_STYLE } from "./nodes";
import { TABLE_ROW_HEIGHT, columnPortId, crowMarker, tableHeaderHeight, tableRowCenterY, type BoundaryFlowNode, type CrowTone, type ShapeFlowEdge, type ShapeFlowNode } from "./shapeDiagram";

/*
 * Style contract of the shape diagrams, shared by every branch: the agent's file holds content only, Hunt draws
 * every element in the colors below, so the same diagram looks the same wherever it was generated. Boxes are
 * Tailwind classes, SVG shapes use the matching `fill-*`/`stroke-*` utilities; added and changed elements reuse the
 * green and amber of the dependency diagram (emerald for added files, amber for the outdated hint).
 */
/** Fill and border of a box per element kind; external systems are dimmed and dashed. */
const BOX_STYLE: Record<Exclude<ShapeKind, "person" | "database" | "queue" | "start" | "end" | "decision" | "table">, string> = {
  system: "border-blue-400/60 bg-blue-500/20 text-neutral-100",
  externalSystem: "border-dashed border-neutral-500 bg-white/[0.03] text-neutral-300 opacity-70",
  container: "border-blue-400/40 bg-blue-500/12 text-neutral-100",
  state: "rounded-xl border-indigo-400/50 bg-indigo-500/15 text-neutral-100",
  action: "border-white/25 bg-white/6 text-neutral-100",
};
const PERSON_STYLE = "border-sky-400/50 bg-sky-500/15 text-neutral-100";
const PERSON_ICON_STYLE = "fill-sky-300/80";
const DATABASE_STYLE = "fill-violet-500/15 stroke-violet-400/60";
const QUEUE_STYLE = "fill-teal-500/15 stroke-teal-400/60";
const DECISION_STYLE = "fill-cyan-500/12 stroke-cyan-400/60";
const TERMINAL_STYLE = "fill-neutral-200 stroke-neutral-200";
/** Border of a table card and tint of its header: neutral, or the change color of an added or changed table. */
const TABLE_TONE: Record<ShapeChange | "none", { card: string; header: string }> = {
  none: { card: "border-white/10", header: "bg-white/[0.045]" },
  added: { card: "border-emerald-400/50", header: "bg-emerald-400/10" },
  changed: { card: "border-amber-400/50", header: "bg-amber-400/10" },
};
const BOUNDARY_STYLE = "border-dashed border-white/15 bg-white/[0.025]";
/** Ring around an element and its corner tag per change; the edge stroke uses the matching hex colors. */
const CHANGE_RING: Record<ShapeChange, string> = { added: "ring-2 ring-emerald-400/70", changed: "ring-2 ring-amber-400/70" };
const CHANGE_TAG: Record<ShapeChange, string> = {
  added: "border-emerald-400/40 bg-emerald-400/15 text-emerald-300",
  changed: "border-amber-400/40 bg-amber-400/15 text-amber-300",
};
export const CHANGE_EDGE_COLOR: Record<ShapeChange, string> = { added: "#34d399", changed: "#fbbf24" };

/** Stroke width of the SVG shapes. */
const SHAPE_STROKE = 1.2;
/** Vertical radius of a cylinder's end caps and horizontal radius of a pipe's. */
const CAP_RADIUS = 8;

/** Small tag in the top-right corner naming what the session did to the element; nothing for unchanged context. */
function ChangeTag({ change }: { change?: ShapeChange }) {
  if (!change) return null;
  return <span className={`absolute -top-2.5 right-2 rounded-md border px-1.5 text-[11px] leading-4 font-medium ${CHANGE_TAG[change]}`}>{change}</span>;
}

/** The element's label on one line and its description as a muted second line; both show in full in the tooltip. */
function Caption({ label, description, className = "" }: { label: string; description?: string; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col items-center text-center ${className}`} title={description ? `${label}\n${description}` : label}>
      <span className="w-full truncate text-[13px] font-medium">{label}</span>
      {description ? <span className="w-full truncate text-[12px] text-neutral-400">{description}</span> : null}
    </div>
  );
}

/** Invisible handles at the top (incoming) and bottom (outgoing) of a node, where the layout attaches the edges. */
function VerticalHandles() {
  return (
    <>
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
    </>
  );
}

/** A system, external system, container, state (rounded) or action (with its actor above the label) as a box. */
export const BoxNodeView = memo(function BoxNodeView({ data }: NodeProps<ShapeFlowNode>) {
  const style = BOX_STYLE[data.kind as keyof typeof BOX_STYLE] ?? BOX_STYLE.action;
  return (
    <div className={`relative flex h-full w-full flex-col items-center justify-center rounded-lg border px-3 py-2 ${style} ${data.change ? CHANGE_RING[data.change] : ""}`}>
      <VerticalHandles />
      <ChangeTag change={data.change} />
      {data.kind === "action" && data.actor ? (
        <span className="w-full truncate text-center text-[11px] tracking-wide text-neutral-400 uppercase" title={data.actor}>
          {data.actor}
        </span>
      ) : null}
      <Caption label={data.label} description={data.description} className="w-full" />
    </div>
  );
});

/** A person: head and shoulders above the label. */
export const PersonNodeView = memo(function PersonNodeView({ data }: NodeProps<ShapeFlowNode>) {
  return (
    <div className={`relative flex h-full w-full flex-col items-center justify-center rounded-2xl border px-3 py-2 ${PERSON_STYLE} ${data.change ? CHANGE_RING[data.change] : ""}`}>
      <VerticalHandles />
      <ChangeTag change={data.change} />
      <svg viewBox="0 0 24 24" className={`mb-1 size-6 shrink-0 ${PERSON_ICON_STYLE}`} aria-hidden="true">
        <circle cx="12" cy="7" r="4.5" />
        <path d="M3 22a9 9 0 0 1 18 0z" />
      </svg>
      <Caption label={data.label} description={data.description} className="w-full" />
    </div>
  );
});

/** A database as a cylinder. */
export const DatabaseNodeView = memo(function DatabaseNodeView({ data }: NodeProps<ShapeFlowNode>) {
  const { width, height } = data;
  const inset = SHAPE_STROKE;
  const rx = (width - 2 * inset) / 2;
  const body = `M${inset} ${CAP_RADIUS + inset} A${rx} ${CAP_RADIUS} 0 0 0 ${width - inset} ${CAP_RADIUS + inset} V${height - CAP_RADIUS - inset} A${rx} ${CAP_RADIUS} 0 0 1 ${inset} ${height - CAP_RADIUS - inset} Z`;
  return (
    <div className={`relative h-full w-full ${data.change ? `rounded-xl ${CHANGE_RING[data.change]}` : ""}`}>
      <VerticalHandles />
      <ChangeTag change={data.change} />
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={`absolute inset-0 ${DATABASE_STYLE}`} strokeWidth={SHAPE_STROKE} aria-hidden="true">
        <path d={body} />
        <ellipse cx={width / 2} cy={CAP_RADIUS + inset} rx={rx} ry={CAP_RADIUS} fill="none" />
      </svg>
      <div className="absolute inset-x-3 top-0 bottom-0 flex items-center justify-center text-neutral-100" style={{ paddingTop: CAP_RADIUS * 2 }}>
        <Caption label={data.label} description={data.description} className="w-full" />
      </div>
    </div>
  );
});

/** A queue as a horizontal pipe, open at its right end. */
export const QueueNodeView = memo(function QueueNodeView({ data }: NodeProps<ShapeFlowNode>) {
  const { width, height } = data;
  const inset = SHAPE_STROKE;
  const ry = (height - 2 * inset) / 2;
  const body = `M${CAP_RADIUS + inset} ${inset} H${width - CAP_RADIUS - inset} A${CAP_RADIUS} ${ry} 0 0 1 ${width - CAP_RADIUS - inset} ${height - inset} H${CAP_RADIUS + inset} A${CAP_RADIUS} ${ry} 0 0 1 ${CAP_RADIUS + inset} ${inset} Z`;
  return (
    <div className={`relative h-full w-full ${data.change ? `rounded-full ${CHANGE_RING[data.change]}` : ""}`}>
      <VerticalHandles />
      <ChangeTag change={data.change} />
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={`absolute inset-0 ${QUEUE_STYLE}`} strokeWidth={SHAPE_STROKE} aria-hidden="true">
        <path d={body} />
        <ellipse cx={width - CAP_RADIUS - inset} cy={height / 2} rx={CAP_RADIUS} ry={ry} fill="none" />
      </svg>
      <div className="absolute inset-y-0 flex items-center justify-center text-neutral-100" style={{ left: CAP_RADIUS * 2, right: CAP_RADIUS * 3 }}>
        <Caption label={data.label} description={data.description} className="w-full" />
      </div>
    </div>
  );
});

/** The start of a flow as a filled circle, its end as a ring with a dot; the label shows in the tooltip. */
export const TerminalNodeView = memo(function TerminalNodeView({ data }: NodeProps<ShapeFlowNode>) {
  const { width, height } = data;
  const radius = Math.min(width, height) / 2 - SHAPE_STROKE;
  return (
    <div className={`relative h-full w-full ${data.change ? `rounded-full ${CHANGE_RING[data.change]}` : ""}`} title={data.description ? `${data.label}\n${data.description}` : data.label}>
      <VerticalHandles />
      <ChangeTag change={data.change} />
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={`absolute inset-0 ${TERMINAL_STYLE}`} strokeWidth={SHAPE_STROKE} role="img" aria-label={data.label}>
        {data.kind === "start" ? (
          <circle cx={width / 2} cy={height / 2} r={radius} />
        ) : (
          <>
            <circle cx={width / 2} cy={height / 2} r={radius} fill="none" />
            <circle cx={width / 2} cy={height / 2} r={Math.max(2, radius - 4)} />
          </>
        )}
      </svg>
    </div>
  );
});

/** A decision as a diamond with the question inside; the text wraps to two lines before it is cut. */
export const DecisionNodeView = memo(function DecisionNodeView({ data }: NodeProps<ShapeFlowNode>) {
  const { width, height } = data;
  const inset = SHAPE_STROKE;
  const points = `${width / 2},${inset} ${width - inset},${height / 2} ${width / 2},${height - inset} ${inset},${height / 2}`;
  return (
    <div className={`relative h-full w-full ${data.change ? `rounded-xl ${CHANGE_RING[data.change]}` : ""}`}>
      <VerticalHandles />
      <ChangeTag change={data.change} />
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={`absolute inset-0 ${DECISION_STYLE}`} strokeWidth={SHAPE_STROKE} strokeLinejoin="round" aria-hidden="true">
        <polygon points={points} />
      </svg>
      <div className="absolute inset-y-0 flex items-center justify-center text-center text-neutral-100" style={{ left: width * 0.22, right: width * 0.22 }} title={data.description ? `${data.label}\n${data.description}` : data.label}>
        <span className="line-clamp-2 text-[12px] leading-snug font-medium">{data.label}</span>
      </div>
    </div>
  );
});

/** A key for a primary-key column. */
function KeyIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="M7.7 8.3 13.5 2.5M11 5l2 2M9.5 6.5l1.5 1.5" />
    </svg>
  );
}

/** An arrow for a foreign-key column, pointing at the table it references. */
function ReferenceIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" />
    </svg>
  );
}

/** A small grid, the icon of a table header. */
function TableIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5V13" />
    </svg>
  );
}

/**
 * One column row of a table: a key icon for a primary or foreign key, the name and the type muted on the right. A
 * lit row takes part in the hovered relationship or table.
 */
function TableRow({ column, isLit }: { column: TableColumn; isLit: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 transition-colors ${isLit ? "bg-sky-400/10" : ""}`} style={{ height: TABLE_ROW_HEIGHT }} title={`${column.name} ${column.type}`}>
      <span className="flex w-4 shrink-0 justify-center">
        {column.isPrimaryKey ? <KeyIcon className="size-3.5 text-amber-300" /> : column.isForeignKey ? <ReferenceIcon className="size-3.5 text-sky-300/90" /> : null}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[13px] ${isLit ? "text-sky-100" : column.isPrimaryKey ? "font-medium text-neutral-100" : "text-neutral-200"}`}>{column.name}</span>
      <span className="shrink-0 font-mono text-[12px] text-neutral-500">{column.type}</span>
    </div>
  );
}

/**
 * An ERD table as a card: a header with the table's name, its description as a second line and the change tag, then
 * one row per column. Each row has an invisible handle on the left (incoming) and the right (outgoing), named by
 * `columnPortId`, so a relationship joins the two columns it is on. The panel marks the selected table (the one in
 * the editor), the hovered one and fades the tables unrelated to the hovered one.
 */
export const TableNodeView = memo(function TableNodeView({ id, data }: NodeProps<ShapeFlowNode>) {
  const columns = data.columns ?? [];
  const lit = new Set(data.litColumns ?? []);
  const tone = TABLE_TONE[data.change ?? "none"];
  const ring = data.isSelected ? "ring-2 ring-blue-400/80" : data.isHovered ? "ring-1 ring-white/20" : "";
  return (
    <div
      className={`relative flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-xl border bg-(--surface-inset) text-neutral-100 shadow-lg shadow-black/30 transition-[opacity,box-shadow] duration-150 ${tone.card} ${ring} ${data.isMuted ? "opacity-40" : ""}`}
    >
      <VerticalHandles />
      {columns.map((column, index) => (
        <Handle key={`in:${column.name}`} type="target" position={Position.Left} id={columnPortId(id, column.name, "in")} style={{ ...HANDLE_STYLE, top: tableRowCenterY(data, index) }} />
      ))}
      {columns.map((column, index) => (
        <Handle key={`out:${column.name}`} type="source" position={Position.Right} id={columnPortId(id, column.name, "out")} style={{ ...HANDLE_STYLE, top: tableRowCenterY(data, index) }} />
      ))}
      <div className={`flex shrink-0 flex-col justify-center gap-0.5 border-b border-white/10 px-3 ${tone.header}`} style={{ height: tableHeaderHeight(data) }} title={data.description ? `${data.label}\n${data.description}` : data.label}>
        <div className="flex items-center gap-2">
          <TableIcon className="size-3.5 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{data.label}</span>
          {data.change ? <span className={`shrink-0 rounded border px-1.5 text-[10px] leading-4 font-semibold tracking-wide uppercase ${CHANGE_TAG[data.change]}`}>{data.change}</span> : null}
        </div>
        {data.description ? <span className="truncate text-[12px] text-neutral-400">{data.description}</span> : null}
      </div>
      <div className="divide-y divide-white/5">
        {columns.map((column) => (
          <TableRow key={column.name} column={column} isLit={lit.has(column.name)} />
        ))}
      </div>
    </div>
  );
});

/**
 * Dashed area behind the elements of one boundary, labeled in its top-left corner. Like the folder areas of the
 * dependency diagram it never catches the mouse, so edges inside it stay hoverable.
 */
export const BoundaryGroupView = memo(function BoundaryGroupView({ data }: NodeProps<BoundaryFlowNode>) {
  return (
    <div className={`pointer-events-none relative h-full w-full rounded-xl border ${BOUNDARY_STYLE} ${data.change ? CHANGE_RING[data.change] : ""}`}>
      <ChangeTag change={data.change} />
      <div className="px-2 pt-2">
        <span className="pointer-events-auto inline-block max-w-full truncate rounded-md bg-(--xy-background-color) px-1 py-0.5 text-[12px] text-neutral-400" title={data.label}>
          {data.label}
        </span>
      </div>
    </div>
  );
});

export const SHAPE_NODE_TYPES: NodeTypes = {
  person: PersonNodeView,
  system: BoxNodeView,
  externalSystem: BoxNodeView,
  container: BoxNodeView,
  database: DatabaseNodeView,
  queue: QueueNodeView,
  start: TerminalNodeView,
  end: TerminalNodeView,
  state: BoxNodeView,
  action: BoxNodeView,
  decision: DecisionNodeView,
  table: TableNodeView,
  boundary: BoundaryGroupView,
};

/** Gap between the label box (or the edge) and the hover card above it. */
const POPOVER_GAP = 6;
/** Opacity of an edge while another edge or an unrelated node is hovered. */
const MUTED_OPACITY = 0.3;

/**
 * A connection on ELK's orthogonal route, drawn brighter while it is hovered or lit by a hovered node and faded while
 * another one is; an added or changed connection keeps its change color. The markers come from the layout
 * (arrowheads, or crow's feet for an ERD). The label sits on the box ELK reserved for it; an edge laid out without
 * one (an ERD relationship) shows its label only in the hover card, which floats above the label box or the middle
 * of the route while the mouse is on the edge or its label.
 */
export function ShapeEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerStart, markerEnd, selected }: EdgeProps<ShapeFlowEdge>) {
  const [isLabelHovered, setIsLabelHovered] = useState(false);
  const points = data?.points ?? [];
  const [fallbackPath, fallbackX, fallbackY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 });
  const path = points.length >= 2 ? orthogonalPath(points) : fallbackPath;
  const labelCenter = data?.labelCenter ?? null;
  const anchor = labelCenter ?? (points.length >= 2 ? pathMidpoint(points) : { x: fallbackX, y: fallbackY });
  const isHighlighted = Boolean(selected) || Boolean(data?.isHovered) || Boolean(data?.isLit) || isLabelHovered;
  const isMuted = Boolean(data?.isMuted) && !isHighlighted;
  const showsLabelInCard = !labelCenter && Boolean(data?.label);
  const showsCard = (Boolean(data?.isHovered) || isLabelHovered) && (showsLabelInCard || Boolean(data?.description));
  const stroke = data?.change ? CHANGE_EDGE_COLOR[data.change] : isHighlighted ? EDGE_COLOR_HIGHLIGHTED : EDGE_COLOR;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={{ stroke, strokeWidth: isHighlighted ? 1.8 : 1.2, opacity: isMuted ? MUTED_OPACITY : 1, transition: "opacity 150ms" }}
      />
      {labelCenter && data?.label ? (
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
        </EdgeLabelRenderer>
      ) : null}
      {showsCard ? (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -100%) translate(${anchor.x}px, ${anchor.y - (labelCenter ? LABEL_HEIGHT / 2 : 0) - POPOVER_GAP}px)`, zIndex: 10 }}
            className="pointer-events-none absolute w-max max-w-[360px] rounded-md border border-white/15 bg-(--surface-inset) px-2.5 py-1.5 text-[13px] leading-snug text-neutral-200 shadow-lg shadow-black/40"
          >
            {showsLabelInCard ? <div className={`font-medium text-neutral-100 ${data?.description ? "mb-0.5" : ""}`}>{data?.label}</div> : null}
            {data?.description ? <div>{data.description}</div> : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const SHAPE_EDGE_TYPES: EdgeTypes = { shape: ShapeEdgeView };

/** Size of the crow's foot markers in px; `refX` puts the foot's open end on the node border. */
const CROW_SIZE = 16;
/** Stroke of the crow's feet per tone: like the edge at rest, lit while hovered, or in its change color. */
const CROW_TONE_COLOR: Record<CrowTone, string> = { rest: EDGE_COLOR, lit: EDGE_COLOR_HIGHLIGHTED, added: CHANGE_EDGE_COLOR.added, changed: CHANGE_EDGE_COLOR.changed };

/**
 * Crow's foot markers of an ERD, one per cardinality and tone, referenced by the edges through `crowMarker` ids:
 * `one` is a bar, `many` three prongs. Sized in user space so they keep their size when a stroke gets thicker, and
 * reversed at an edge's start so the foot's open end points at the node on either end.
 */
export function CrowFootDefs() {
  const markerProps = {
    markerWidth: CROW_SIZE,
    markerHeight: CROW_SIZE,
    viewBox: `0 0 ${CROW_SIZE} ${CROW_SIZE}`,
    refX: CROW_SIZE,
    refY: CROW_SIZE / 2,
    markerUnits: "userSpaceOnUse" as const,
    orient: "auto-start-reverse",
    fill: "none",
    strokeWidth: 1.4,
  };
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        {(Object.keys(CROW_TONE_COLOR) as CrowTone[]).map((tone) => (
          <g key={tone}>
            <marker id={crowMarker("one", tone)} {...markerProps} stroke={CROW_TONE_COLOR[tone]}>
              <path d="M6 2 V14" />
            </marker>
            <marker id={crowMarker("many", tone)} {...markerProps} stroke={CROW_TONE_COLOR[tone]}>
              <path d="M4 8 L16 2 M4 8 L16 8 M4 8 L16 14" />
            </marker>
          </g>
        ))}
      </defs>
    </svg>
  );
}
