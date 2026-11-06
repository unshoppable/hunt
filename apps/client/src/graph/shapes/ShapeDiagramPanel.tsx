import { useCallback, useEffect, useRef, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type FinalConnectionState, type ReactFlowInstance } from "@xyflow/react";
import { commands } from "../../ipc/commands";
import type { ShapeDiagramType } from "../../common/diagram/diagram.types";
import type { GraphStatus } from "../graph.types";
import type { ShapeDiagram, ShapeKind, ShapePosition } from "./shape-diagram.types";
import { DIAGRAM_FONT_SIZE, useSettingsStore } from "../../settings/settings.store";
import { useHuntStore } from "../../sessions/hunt.store";
import { STATUS_BAR } from "../../ui/bars.constants";
import { SECONDARY_BUTTON_XS } from "../../ui/buttons.constants";
import { Dropdown } from "../../ui/Dropdown";
import { PlusIcon, Spinner } from "../../ui/Icons";
import { useLoad } from "../../ui/load.hook";
import { errorText } from "../../ui/error-text.utils";
import { DiagramStatusBadge, DiagramTypeDropdown, GenerateSplitButton, SaveDiagramButton } from "../DiagramToolbar";
import { DIAGRAM_TYPES, KINDS_BY_TYPE } from "../diagram-types.constants";
import { addTable, emptyErd, serializeShapeDiagram } from "./erd-edit.utils";
import { addEdge, addGroup, addNode, clearPositions, emptyDiagram, setBends, setPositions } from "./shape-edit.utils";
import { decorateShapeFlow, hasManualChanges, hasManualLayout, layoutShapeDiagram, shapeNodeSize, type ShapeDiagramFlowNode, type ShapeFlowEdge, type ShapeFocus } from "./shape-diagram.utils";
import { CHANGE_EDGE_COLOR, CrowFootDefs, EdgeBendsContext, SHAPE_EDGE_TYPES, SHAPE_NODE_TYPES } from "./ShapeNodes";
import { parseShapeDiagram } from "./shape-schema.utils";
import { KIND_NAMES, ShapeElementEditor, type ShapeSelection } from "./ShapeElementEditor";
import { TableEditor } from "./TableEditor";

/** How long after the last edit the diagram file is written; edits within that time are written together. */
const WRITE_DELAY_MS = 400;
const NO_HOVER = { hoveredEdgeId: null, hoveredNodeId: null };

/**
 * Where a shape diagram comes from: the file the agent generates for the session in `.hunt/diagrams/`, or a diagram
 * file of the repository (saved there from a generated one), whose type its content declares.
 */
export type ShapeDiagramSource = { kind: "generated"; type: ShapeDiagramType } | { kind: "file"; path: string; type: ShapeDiagramType };

/**
 * One of the shape diagrams of the Architecture tab (C4 context, C4 container, states, ERD, process): the content of
 * its diagram file, validated and laid out with ELK inside React Flow in Hunt's fixed style, or placed where the user
 * dragged its elements. Hovering an edge shows its description, hovering a node lights its edges; everything else
 * fades meanwhile. Every diagram is editable: a click on an element, connection or boundary label opens its editor
 * beside the canvas (the table editor for an ERD table), the toolbar adds elements and boundaries, dragging from the
 * dot under an element connects it to another one, and dragging an element fixes the positions of all of them until
 * Auto-layout drops them again. Every edit shows at once and is written back to the file shortly after. For a
 * generated diagram the toolbar also shows whether files changed since it was generated, generates or updates it, and
 * saves it into the repository, after which the tab shows the saved file; nothing is generated without a click.
 */
export function ShapeDiagramPanel({ sessionId, source }: { sessionId: string; source: ShapeDiagramSource }) {
  const diagramType = source.type;
  const filePath = source.kind === "file" ? source.path : null;
  const graphVersion = useHuntStore((state) => state.chats[sessionId]?.graphVersion ?? 0);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const isGeneratingGraph = useHuntStore((state) => (!filePath && state.chats[sessionId]?.generatingDiagrams.includes(diagramType)) ?? false);
  const generateError = useHuntStore((state) => (filePath ? null : (state.chats[sessionId]?.diagramErrors[diagramType] ?? null)));
  const refreshGraph = useHuntStore((state) => state.refreshGraph);
  const setDiagramFile = useSettingsStore((state) => state.setDiagramFile);
  const typeName = DIAGRAM_TYPES.find((type) => type.id === diagramType)?.name ?? diagramType;
  const isErd = diagramType === "erd";

  /** Undefined until the file was read, null when there is none. */
  const [diagram, setDiagram] = useState<ShapeDiagram | null | undefined>(undefined);
  /** The file content of `diagram`, to tell a reload of the user's own write from a rewrite by the agent or an editor. */
  const serializedRef = useRef<string | null>(null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  /** When the diagram was generated and whether files changed since; refetched with the diagram and with every edit. */
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<Pick<ShapeFocus, "hoveredEdgeId" | "hoveredNodeId">>(NO_HOVER);
  const [selection, setSelection] = useState<ShapeSelection | null>(null);
  /** The element, connection or boundary added last, whose editor starts with the name selected. */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  /** Bumped when a layout with other elements lands, so React Flow remounts and fits the diagram into view. */
  const [layoutVersion, setLayoutVersion] = useState(0);
  /** The node text is `DIAGRAM_FONT_SIZE` px at 100 % zoom; the diagram opens zoomed so it shows at the Architecture pane's font size. */
  const zoomScale = useSettingsStore((state) => state.panes.architecture.fontSize) / DIAGRAM_FONT_SIZE;
  const fitViewOptions = { padding: 0.1, minZoom: 0.3 * zoomScale, maxZoom: 1.2 * zoomScale };
  const elementIdsRef = useRef("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<ShapeDiagramFlowNode, ShapeFlowEdge> | null>(null);
  /** The last layout before decoration; the flags are applied to it whenever the focus changes. */
  const layoutRef = useRef<{ nodes: ShapeDiagramFlowNode[]; edges: ShapeFlowEdge[] }>({ nodes: [], edges: [] });
  const [nodes, setNodes, onNodesChange] = useNodesState<ShapeDiagramFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ShapeFlowEdge>([]);
  const { hoveredEdgeId, hoveredNodeId } = hover;
  const selectedNodeId = selection?.kind === "node" ? selection.id : null;
  const selectedEdgeId = selection?.kind === "edge" ? selection.id : null;
  const focus: ShapeFocus = { hoveredEdgeId, hoveredNodeId, selectedNodeId, selectedEdgeId };

  const readDiagram = (): Promise<unknown> =>
    filePath ? commands.readFile(sessionId, filePath).then((content) => JSON.parse(content) as unknown) : commands.readGraph(sessionId, diagramType);

  useLoad(
    () => readDiagram(),
    {
      onValue: (raw) => {
        if (raw === null || raw === undefined) {
          serializedRef.current = null;
          setDiagram(null);
          setProblems([]);
        } else {
          const parsed = parseShapeDiagram(raw, diagramType, filePath ?? undefined);
          const serialized = serializeShapeDiagram(parsed.diagram);
          if (serialized !== serializedRef.current) {
            serializedRef.current = serialized;
            setDiagram(parsed.diagram);
          }
          setProblems(parsed.problems);
        }
        setError(null);
      },
      onError: (reason) => setError(filePath ? `Reading ${filePath} failed: ${errorText(reason)}` : errorText(reason)),
    },
    // A diagram file of the repository changes like any worktree file; the generated one reports its own rewrites.
    [sessionId, diagramType, filePath, filePath ? editVersion : graphVersion],
  );

  useLoad(
    () => (filePath ? Promise.resolve(null) : commands.graphStatus(sessionId, diagramType)),
    { onValue: setStatus, onError: (reason) => setError(errorText(reason)) },
    [sessionId, diagramType, filePath, graphVersion, editVersion],
  );

  useLoad(
    (signal) => (diagram ? layoutShapeDiagram(diagram, signal) : Promise.resolve({ nodes: [], edges: [] })),
    {
      onValue: (flow) => {
        layoutRef.current = flow;
        const decorated = decorateShapeFlow(flow.nodes, flow.edges, focus, isErd);
        setNodes(decorated.nodes);
        setEdges(decorated.edges);
        const elementIds = flow.nodes.map((node) => node.id).join("\n");
        if (elementIds !== elementIdsRef.current) {
          elementIdsRef.current = elementIds;
          setLayoutVersion((version) => version + 1);
        }
      },
      onError: (reason) => setError(`Layout failed: ${errorText(reason)}`),
    },
    [diagram, isErd, setNodes, setEdges],
  );

  // The flags follow the mouse and the selection without a new layout.
  useEffect(() => {
    const decorated = decorateShapeFlow(layoutRef.current.nodes, layoutRef.current.edges, { hoveredEdgeId, hoveredNodeId, selectedNodeId, selectedEdgeId }, isErd);
    setNodes(decorated.nodes);
    setEdges(decorated.edges);
  }, [hoveredEdgeId, hoveredNodeId, selectedNodeId, selectedEdgeId, isErd, setNodes, setEdges]);

  /** Shows `next` at once and writes it to the diagram file after `WRITE_DELAY_MS`; the reload it triggers is recognised and skipped. */
  const applyEdit = useCallback(
    (next: ShapeDiagram) => {
      const serialized = serializeShapeDiagram(next);
      serializedRef.current = serialized;
      setDiagram(next);
      if (writeTimer.current) {
        clearTimeout(writeTimer.current);
      }
      writeTimer.current = setTimeout(() => {
        writeTimer.current = null;
        const write = filePath ? commands.writeFile(sessionId, filePath, serialized) : commands.writeGraph(sessionId, diagramType, serialized);
        write.catch((reason) => setError(`Saving the diagram failed: ${errorText(reason)}`));
      }, WRITE_DELAY_MS);
    },
    [sessionId, diagramType, filePath],
  );

  // A pending write goes out when the panel closes, so no edit is lost to a tab switch.
  useEffect(
    () => () => {
      if (!writeTimer.current || !serializedRef.current) return;
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
      void (filePath ? commands.writeFile(sessionId, filePath, serializedRef.current) : commands.writeGraph(sessionId, diagramType, serializedRef.current));
    },
    [sessionId, diagramType, filePath],
  );

  const select = (next: ShapeSelection, isNew = false) => {
    setSelection(next);
    setCreatedId(isNew ? next.id : null);
  };

  /** Middle of the visible canvas in diagram coordinates, minus half of `size`, so a new element lands in view. */
  const viewCenter = (size: { width: number; height: number }): ShapePosition | undefined => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !flowRef.current) return undefined;
    const center = flowRef.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    return { x: center.x - size.width / 2, y: center.y - size.height / 2 };
  };

  const addNewTable = () => {
    const added = addTable(diagram ?? emptyErd(), "new_table");
    const table = added.diagram.nodes.find((node) => node.id === added.id);
    const position = table && hasManualLayout(added.diagram) ? viewCenter(shapeNodeSize(table)) : undefined;
    applyEdit(position ? setPositions(added.diagram, new Map([[added.id, position]])) : added.diagram);
    select({ kind: "node", id: added.id }, true);
  };

  const addNewElement = (kind: ShapeKind) => {
    const base = diagram ?? emptyDiagram(diagramType);
    const label = `New ${KIND_NAMES[kind].toLowerCase()}`;
    const position = hasManualLayout(base) ? viewCenter(shapeNodeSize({ id: "", kind, label })) : undefined;
    const added = addNode(base, kind, label, position);
    applyEdit(added.diagram);
    select({ kind: "node", id: added.id }, true);
  };

  const addNewGroup = () => {
    const added = addGroup(diagram ?? emptyDiagram(diagramType), "New boundary");
    applyEdit(added.diagram);
    select({ kind: "group", id: added.id }, true);
  };

  /** Fixes every element where it is now, so the one just dragged stays where it was dropped. */
  /** Fixes the corners of the connection `edgeId` whose segment the user moved, or lets Hunt route it again. */
  const moveConnection = (edgeId: string, bends: ShapePosition[] | null) => {
    if (diagram) applyEdit(setBends(diagram, edgeId, bends));
  };

  const keepPositions = () => {
    if (!diagram) return;
    const boundaries = new Map(nodes.filter((node) => node.type === "boundary").map((node) => [node.id, node.position]));
    const positions = new Map(
      nodes
        .filter((node) => node.type !== "boundary")
        .map((node) => {
          const origin = node.parentId ? (boundaries.get(node.parentId) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
          return [node.id, { x: origin.x + node.position.x, y: origin.y + node.position.y }];
        }),
    );
    applyEdit(setPositions(diagram, positions));
  };

  /** Connects the element a connection was dragged from to the element it was dropped on, a handle or anywhere on it. */
  const connect = (event: MouseEvent | TouchEvent, connection: FinalConnectionState) => {
    if (!diagram || !connection.fromNode) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const dropped = point ? document.elementFromPoint(point.clientX, point.clientY)?.closest(".react-flow__node")?.getAttribute("data-id") : null;
    const target = connection.toNode?.id ?? dropped;
    if (!target) return;
    const added = addEdge(diagram, connection.fromNode.id, target);
    if (!added.id) return;
    applyEdit(added.diagram);
    select({ kind: "edge", id: added.id }, true);
  };

  const selectedNode = diagram && selection?.kind === "node" ? diagram.nodes.find((node) => node.id === selection.id) : undefined;
  const hasManualEdits = diagram ? hasManualChanges(diagram) : false;
  const isOutdated = Boolean(diagram) && Boolean(status?.isOutdated);
  const generatedAt = status?.generatedAt ? new Date(status.generatedAt).toLocaleString() : null;
  const hint = isGeneratingGraph
    ? "Generating…"
    : filePath
      ? filePath
      : diagram === null
        ? `No ${typeName} diagram yet`
        : problems.length
          ? "Parts of the agent's diagram do not match the schema and are left out; update the diagram to get them."
          : isOutdated
            ? "Files changed since the diagram was generated"
            : null;
  const emptyText = diagram
    ? "The diagram has no elements; add one or update it to fill it."
    : isErd
      ? "Generate the ERD from the session's changes, or add a table to start one by hand."
      : `Generate the ${typeName} diagram, or add an element to start one by hand.`;
  const elementKinds = KINDS_BY_TYPE[diagramType].filter((kind) => kind !== "table");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-(--line) px-3 py-2.5 text-[13px]">
        <DiagramTypeDropdown sessionId={sessionId} />
        {filePath ? null : (
          <GenerateSplitButton
            label={isGeneratingGraph ? "Generating…" : diagram ? "Update diagram" : "Generate diagram"}
            isDisabled={isGeneratingGraph}
            onGenerate={(instructions) => void refreshGraph(sessionId, diagramType, instructions)}
          />
        )}
        {diagram !== undefined && !error ? (
          isErd ? (
            <button type="button" onClick={addNewTable} disabled={isGeneratingGraph} title="Add a table to the diagram" className={SECONDARY_BUTTON_XS}>
              <PlusIcon /> Table
            </button>
          ) : (
            <>
              <Dropdown
                title="Add an element to the diagram"
                value=""
                placeholder="+ Element"
                options={elementKinds.map((kind) => ({ id: kind, name: KIND_NAMES[kind] }))}
                onChange={(kind) => addNewElement(kind as ShapeKind)}
                disabled={isGeneratingGraph}
                className={SECONDARY_BUTTON_XS}
              />
              {diagramType === "c4-context" || diagramType === "c4-container" ? (
                <button type="button" onClick={addNewGroup} disabled={isGeneratingGraph} title="Add a boundary to the diagram" className={SECONDARY_BUTTON_XS}>
                  <PlusIcon /> Boundary
                </button>
              ) : null}
            </>
          )
        ) : null}
        {hasManualEdits ? (
          <button type="button" onClick={() => diagram && applyEdit(clearPositions(diagram))} title="Drop the positions and connection courses set by hand and lay the diagram out automatically" className={SECONDARY_BUTTON_XS}>
            Auto-layout
          </button>
        ) : null}
        {!filePath && diagram?.nodes.length ? (
          <SaveDiagramButton sessionId={sessionId} diagram={diagram} content={() => serializeShapeDiagram(diagram)} onSaved={(path) => setDiagramFile(sessionId, path)} />
        ) : null}
        <span
          className={`flex min-w-0 flex-1 items-center gap-2 ${isGeneratingGraph ? "text-neutral-400" : !filePath && (problems.length || isOutdated) ? "text-amber-300/90" : "text-neutral-500"}`}
          title={filePath ?? (generatedAt ? `Diagram generated ${generatedAt}` : undefined)}
        >
          {isGeneratingGraph ? <Spinner className="size-5 shrink-0" /> : null}
          {hint ? <span className={`truncate ${filePath ? "font-mono text-[12px]" : ""}`}>{hint}</span> : null}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div ref={canvasRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {filePath ? null : <DiagramStatusBadge status={status} hasDiagram={Boolean(diagram)} />}
          {error || generateError ? (
            <div className="absolute inset-x-3 top-3 z-10 flex items-start gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[13px] text-red-300">
              <p className="min-w-0 flex-1">{error ?? generateError}</p>
              {filePath ? (
                <button type="button" onClick={() => setDiagramFile(sessionId, null)} className={SECONDARY_BUTTON_XS}>
                  Back to the generated diagrams
                </button>
              ) : null}
            </div>
          ) : null}
          <ReactFlowProvider key={`${layoutVersion}:${zoomScale}`}>
            <EdgeBendsContext.Provider value={moveConnection}>
            {diagram?.nodes.length ? (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onInit={(instance) => {
                  flowRef.current = instance;
                }}
                nodeTypes={SHAPE_NODE_TYPES}
                edgeTypes={SHAPE_EDGE_TYPES}
                onEdgeMouseEnter={(_event, edge) => setHover((current) => ({ ...current, hoveredEdgeId: edge.id }))}
                onEdgeMouseLeave={() => setHover((current) => ({ ...current, hoveredEdgeId: null }))}
                onNodeMouseEnter={(_event, node) => {
                  if (node.type === "boundary") return;
                  setHover((current) => ({ ...current, hoveredNodeId: node.id }));
                }}
                onNodeMouseLeave={() => setHover((current) => ({ ...current, hoveredNodeId: null }))}
                onNodeClick={(_event, node) => select({ kind: node.type === "boundary" ? "group" : "node", id: node.id })}
                onEdgeClick={(_event, edge) => select({ kind: "edge", id: edge.id })}
                onPaneClick={() => setSelection(null)}
                onNodeDragStop={(_event, node) => {
                  // A press without a move keeps the automatic layout.
                  const before = layoutRef.current.nodes.find((candidate) => candidate.id === node.id)?.position;
                  if (before && before.x === node.position.x && before.y === node.position.y) return;
                  keepPositions();
                }}
                onConnectEnd={connect}
                fitView
                fitViewOptions={fitViewOptions}
                minZoom={0.2}
                maxZoom={2 * Math.max(1, zoomScale)}
                colorMode="dark"
                className={isErd ? undefined : "shape-canvas-editable"}
                nodesDraggable
                nodesConnectable={!isErd}
                elementsSelectable={false}
                deleteKeyCode={null}
                zIndexMode="manual"
                proOptions={{ hideAttribution: true }}
              >
                {isErd ? <CrowFootDefs /> : null}
                <Background gap={24} color="#2f343d" />
                <Controls showInteractive={false} fitViewOptions={fitViewOptions} />
                <ShapeMiniMap />
              </ReactFlow>
            ) : diagram === undefined ? null : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">{emptyText}</div>
            )}
            </EdgeBendsContext.Provider>
          </ReactFlowProvider>
        </div>
        {diagram && selection ? (
          isErd && selectedNode?.kind === "table" ? (
            <TableEditor key={selectedNode.id} diagram={diagram} table={selectedNode} isNew={selectedNode.id === createdId} onChange={applyEdit} onClose={() => setSelection(null)} />
          ) : (
            <ShapeElementEditor
              key={`${selection.kind}:${selection.id}`}
              diagram={diagram}
              selection={selection}
              isNew={selection.id === createdId}
              onChange={applyEdit}
              onClose={() => setSelection(null)}
            />
          )
        ) : null}
      </div>

      {showProblems && problems.length ? (
        <ul className="max-h-32 overflow-auto border-t border-(--line) bg-amber-500/5 px-3 py-2.5 text-[13px] text-amber-200/90">
          {problems.map((problem, position) => (
            <li key={position}>{problem}</li>
          ))}
        </ul>
      ) : null}

      <div className={`${STATUS_BAR} gap-3 text-neutral-500`}>
        <span className="min-w-0 flex-1 truncate">
          {diagram?.title ? `${diagram.title} · ` : ""}
          {isErd ? `${diagram?.nodes.length ?? 0} tables · ${diagram?.edges.length ?? 0} relationships` : `${diagram?.nodes.length ?? 0} elements · ${diagram?.edges.length ?? 0} connections`}
        </span>
        {diagram?.nodes.length && !selection ? (
          <span className="shrink-0">{isErd
              ? "Click a table to edit it, drag it or a line to move it"
              : "Click to edit, drag an element or a line to move it, drag from the dot below an element to connect it"}</span>
        ) : null}
        {problems.length ? (
          <button type="button" onClick={() => setShowProblems((value) => !value)} className="shrink-0 text-amber-300/90 hover:text-amber-200">
            {problems.length} schema {problems.length === 1 ? "problem" : "problems"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Overview of the whole diagram in the bottom-right corner: drag or scroll it to move and zoom the view, click to center there. */
function ShapeMiniMap() {
  const { getZoom, setCenter } = useReactFlow();
  return (
    <MiniMap<ShapeDiagramFlowNode>
      pannable
      zoomable
      ariaLabel="Diagram overview"
      nodeColor={miniMapNodeColor}
      nodeBorderRadius={4}
      maskStrokeWidth={1}
      onClick={(_event, position) => void setCenter(position.x, position.y, { zoom: getZoom(), duration: 200 })}
      className="overflow-hidden rounded-md border border-(--line)"
    />
  );
}

function miniMapNodeColor(node: ShapeDiagramFlowNode): string {
  if (node.type === "boundary") return "rgba(255, 255, 255, 0.05)";
  return node.data.change ? CHANGE_EDGE_COLOR[node.data.change] : "#8a919e";
}
