import { useLayoutEffect, useRef, useState } from "react";
import { useStoreApi, useViewport, type XYPosition } from "@xyflow/react";
import type { DiagramEdge, DiagramNode, LitElements } from "./diagram";
import { CARD_GAP, placeCard, type Obstacles, type Rect } from "./cardPlacement";
import { useFileIconUrl } from "../diff/fileIcons";
import { baseName } from "../ui/path";

/** One dependency of the hovered file with the file it points at. */
export type OutgoingDependency = { edge: DiagramEdge; target: DiagramNode | null };

const CARD_WIDTH = 380;
/** Distance between two sampled points along a lit edge, in viewport pixels. */
const EDGE_SAMPLE_STEP = 6;

/**
 * Card next to the hovered file listing what it depends on: one row per outgoing edge with the target's name, the
 * edge label and its description. It is only shown for files with at least one outgoing edge. The card measures
 * every lit element of the canvas (`lit`: the files, the edges with their labels, wherever the layout put them) and
 * takes the closest spot that covers none of them, see `placeCard`; it stays inside the canvas and fades in briefly.
 * The mouse can move onto the card to read or scroll it: `onMouseEnter` and `onMouseLeave` keep and release the
 * hover. A click on a file name calls `onOpen` with that file, the same as a click on its box. The spot is chosen once
 * per hovered file and zoom level and then pinned to the file: panning the canvas moves the card along with it, the
 * canvas clips it at its border.
 * Needs a `ReactFlowProvider` around it to follow the viewport.
 */
export function DependencyCard({
  node,
  dependencies,
  lit,
  onMouseEnter,
  onMouseLeave,
  onOpen,
}: {
  node: DiagramNode;
  dependencies: OutgoingDependency[];
  lit: LitElements;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onOpen: (node: DiagramNode) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const store = useStoreApi();
  const viewport = useViewport();
  const [pin, setPin] = useState<Pin | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const canvas = card?.parentElement;
    if (!card || !canvas) return;
    const anchor = rectOf(fileElement(canvas, node.path), canvas);
    if (!anchor) return;
    const obstacles: Obstacles = { rects: [], points: [] };
    for (const path of lit.nodePaths) {
      if (path === node.path) continue;
      const rect = rectOf(fileElement(canvas, path), canvas);
      if (rect) {
        obstacles.rects.push(rect);
      }
    }
    for (const edgeId of lit.edgeIds) {
      const labelRect = rectOf(canvas.querySelector(`[data-edge-id="${CSS.escape(edgeId)}"]`), canvas);
      if (labelRect) {
        obstacles.rects.push(labelRect);
      }
      obstacles.points.push(...edgePoints(canvas, edgeId));
    }
    const spot = placeCard({
      canvas: { width: canvas.clientWidth, height: canvas.clientHeight },
      card: { width: Math.min(CARD_WIDTH, canvas.clientWidth - 2 * CARD_GAP), height: card.offsetHeight },
      anchor,
      obstacles,
    });
    const [translateX, translateY, zoom] = store.getState().transform;
    setPin({
      anchor: { x: (anchor.left - translateX) / zoom, y: (anchor.top - translateY) / zoom },
      offset: { x: spot.x - anchor.left, y: spot.y - anchor.top },
    });
    // The zoom level is a dependency on purpose: zooming resizes everything lit, so the spot is chosen again.
  }, [node, dependencies, lit, store, viewport.zoom]);

  const spot = pin
    ? { x: pin.anchor.x * viewport.zoom + viewport.x + pin.offset.x, y: pin.anchor.y * viewport.zoom + viewport.y + pin.offset.y }
    : { x: CARD_GAP, y: CARD_GAP };

  return (
    <div
      ref={cardRef}
      style={{ left: spot.x, top: spot.y, width: CARD_WIDTH }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="absolute z-10 flex animate-fade-in max-h-[calc(100%-1rem)] max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-md border border-white/15 bg-(--surface-inset) text-[13px] leading-snug text-neutral-200 shadow-lg shadow-black/40"
    >
      <div className="flex items-center gap-1.5 border-b border-(--line) px-2.5 py-1.5">
        <FileButton node={node} onOpen={onOpen} />
        <span className="shrink-0 text-neutral-500">
          {dependencies.length === 1 ? "depends on 1 file" : `depends on ${dependencies.length} files`}
        </span>
      </div>
      <ul className="min-h-0 divide-y divide-(--line) overflow-y-auto">
        {dependencies.map(({ edge, target }) => (
          <li key={edge.id} className="px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-neutral-500">→</span>
              {target ? (
                <FileButton node={target} onOpen={onOpen} />
              ) : (
                <span className="min-w-0 flex-1 truncate font-medium text-neutral-100">{baseName(edge.target)}</span>
              )}
              {edge.label ? (
                <span className="ml-auto shrink-0 rounded-md border border-white/20 px-2 py-[3px] text-[12px] leading-[18px] text-neutral-100">{edge.label}</span>
              ) : null}
            </div>
            {edge.description ? <p className="mt-1 text-neutral-300">{edge.description}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Icon and name of a file; a click opens it through `onOpen`. */
function FileButton({ node, onOpen }: { node: DiagramNode; onOpen: (node: DiagramNode) => void }) {
  const fileIconUrl = useFileIconUrl();
  return (
    <button
      type="button"
      onClick={() => onOpen(node)}
      title={node.isChanged ? `Show the diff of ${node.path}` : `Open ${node.path} in the editor`}
      className="flex min-w-0 items-center gap-1.5 font-medium text-neutral-100 hover:underline"
    >
      <img src={fileIconUrl(node.path)} alt="" className="size-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

/** Where the card sits: the hovered file's top-left corner in flow coordinates and the card's offset from it in pixels. */
type Pin = { anchor: XYPosition; offset: XYPosition };

/** React Flow's wrapper element of the file node with that path. */
function fileElement(canvas: HTMLElement, path: string): Element | null {
  return canvas.querySelector(`.react-flow__node[data-id="${CSS.escape(path)}"]`);
}

/** Box of `element` relative to the canvas, or null when there is no element. */
function rectOf(element: Element | null, canvas: HTMLElement): Rect | null {
  if (!element) return null;
  const canvasRect = canvas.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return { left: rect.left - canvasRect.left, top: rect.top - canvasRect.top, right: rect.right - canvasRect.left, bottom: rect.bottom - canvasRect.top };
}

/** Points along the drawn path of the edge with that id, every `EDGE_SAMPLE_STEP` viewport pixels, relative to the canvas. */
function edgePoints(canvas: HTMLElement, edgeId: string): XYPosition[] {
  const path = canvas.querySelector(`.react-flow__edge[data-id="${CSS.escape(edgeId)}"] path.react-flow__edge-path`);
  if (!(path instanceof SVGPathElement)) return [];
  const matrix = path.getScreenCTM();
  if (!matrix) return [];
  const canvasRect = canvas.getBoundingClientRect();
  const scale = Math.hypot(matrix.a, matrix.b) || 1;
  const length = path.getTotalLength();
  const points: XYPosition[] = [];
  for (let distance = 0; distance <= length; distance += EDGE_SAMPLE_STEP / scale) {
    const point = path.getPointAtLength(distance).matrixTransform(matrix);
    points.push({ x: point.x - canvasRect.left, y: point.y - canvasRect.top });
  }
  return points;
}
