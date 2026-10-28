import { useCallback, useEffect, useRef, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from "@xyflow/react";
import { commands } from "../../ipc/commands";
import type { ShapeDiagramType } from "../../common/diagram/diagram.types";
import type { GraphStatus } from "../graph.types";
import type { ShapeDiagram } from "./shape-diagram.types";
import { DIAGRAM_FONT_SIZE, useSettingsStore } from "../../settings/settings.store";
import { useHuntStore } from "../../sessions/hunt.store";
import { STATUS_BAR } from "../../ui/bars.constants";
import { SECONDARY_BUTTON_XS } from "../../ui/buttons.constants";
import { PlusIcon, Spinner } from "../../ui/Icons";
import { useLoad } from "../../ui/load.hook";
import { errorText } from "../../ui/error-text.utils";
import { DiagramStatusBadge, DiagramTypeDropdown, GenerateSplitButton } from "../DiagramToolbar";
import { DIAGRAM_TYPES } from "../diagram-types.constants";
import { addTable, emptyErd, serializeShapeDiagram } from "./erd-edit.utils";
import { decorateShapeFlow, layoutShapeDiagram, type ShapeDiagramFlowNode, type ShapeFlowEdge, type ShapeFocus } from "./shape-diagram.utils";
import { CHANGE_EDGE_COLOR, CrowFootDefs, SHAPE_EDGE_TYPES, SHAPE_NODE_TYPES } from "./ShapeNodes";
import { parseShapeDiagram } from "./shape-schema.utils";
import { TableEditor } from "./TableEditor";

/** How long after the last edit the diagram file is written; edits within that time are written together. */
const WRITE_DELAY_MS = 400;
const NO_FOCUS: ShapeFocus = { hoveredEdgeId: null, hoveredNodeId: null, selectedNodeId: null };

/**
 * One of the shape diagrams of the Architecture tab (C4 context, C4 container, states, ERD, process): the content the
 * agent wrote to `.hunt/diagram.<type>.json`, validated and laid out with ELK inside React Flow in Hunt's fixed
 * style. Hovering an edge shows its description, hovering a node lights its edges; everything else fades meanwhile.
 * An ERD is editable: a click on a table opens its editor beside the canvas, the toolbar adds a table, and every edit
 * shows at once and is written back to the file shortly after, where the agent reads it on the next update. The
 * toolbar switches the diagram type, shows whether files changed since the diagram was generated and generates or
 * updates it, with optional instructions for that run; nothing is generated without a click.
 */
export function ShapeDiagramPanel({ sessionId, diagramType }: { sessionId: string; diagramType: ShapeDiagramType }) {
  const graphVersion = useHuntStore((state) => state.chats[sessionId]?.graphVersion ?? 0);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const isGeneratingGraph = useHuntStore((state) => state.chats[sessionId]?.generatingDiagrams.includes(diagramType) ?? false);
  const generateError = useHuntStore((state) => state.chats[sessionId]?.diagramErrors[diagramType] ?? null);
  const refreshGraph = useHuntStore((state) => state.refreshGraph);
  const typeName = DIAGRAM_TYPES.find((type) => type.id === diagramType)?.name ?? diagramType;
  const isErd = diagramType === "erd";

  /** Undefined until the file was read, null when there is none. */
  const [diagram, setDiagram] = useState<ShapeDiagram | null | undefined>(undefined);
  /** The file content of `diagram`, to tell a reload of the user's own write from a rewrite by the agent. */
  const serializedRef = useRef<string | null>(null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  /** When the diagram was generated and whether files changed since; refetched with the diagram and with every edit. */
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<ShapeFocus>(NO_FOCUS);
  /** The last layout before decoration; the flags are applied to it whenever the focus changes. */
  const layoutRef = useRef<{ nodes: ShapeDiagramFlowNode[]; edges: ShapeFlowEdge[] }>({ nodes: [], edges: [] });
  /** The table added last, whose editor starts with the name selected. */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  /** Bumped when a layout with other elements lands, so React Flow remounts and fits the diagram into view. */
  const [layoutVersion, setLayoutVersion] = useState(0);
  /** The node text is `DIAGRAM_FONT_SIZE` px at 100 % zoom; the diagram opens zoomed so it shows at the Architecture pane's font size. */
  const zoomScale = useSettingsStore((state) => state.panes.architecture.fontSize) / DIAGRAM_FONT_SIZE;
  const fitViewOptions = { padding: 0.1, minZoom: 0.3 * zoomScale, maxZoom: 1.2 * zoomScale };
  const elementIdsRef = useRef("");
  const [nodes, setNodes, onNodesChange] = useNodesState<ShapeDiagramFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ShapeFlowEdge>([]);

  useLoad(
    () => commands.readGraph(sessionId, diagramType),
    {
      onValue: (raw) => {
        if (raw === null || raw === undefined) {
          serializedRef.current = null;
          setDiagram(null);
          setProblems([]);
        } else {
          const parsed = parseShapeDiagram(raw, diagramType);
          const serialized = serializeShapeDiagram(parsed.diagram);
          if (serialized !== serializedRef.current) {
            serializedRef.current = serialized;
            setDiagram(parsed.diagram);
          }
          setProblems(parsed.problems);
        }
        setError(null);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, diagramType, graphVersion],
  );

  useLoad(() => commands.graphStatus(sessionId, diagramType), { onValue: setStatus, onError: (reason) => setError(errorText(reason)) }, [sessionId, diagramType, graphVersion, editVersion]);

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
    const decorated = decorateShapeFlow(layoutRef.current.nodes, layoutRef.current.edges, focus, isErd);
    setNodes(decorated.nodes);
    setEdges(decorated.edges);
  }, [focus, isErd, setNodes, setEdges]);

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
        commands.writeGraph(sessionId, diagramType, serialized).catch((reason) => setError(`Saving the diagram failed: ${errorText(reason)}`));
      }, WRITE_DELAY_MS);
    },
    [sessionId, diagramType],
  );

  // A pending write goes out when the panel closes, so no edit is lost to a tab switch.
  useEffect(
    () => () => {
      if (!writeTimer.current || !serializedRef.current) return;
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
      void commands.writeGraph(sessionId, diagramType, serializedRef.current);
    },
    [sessionId, diagramType],
  );

  const addNewTable = () => {
    const added = addTable(diagram ?? emptyErd(), "new_table");
    applyEdit(added.diagram);
    setCreatedId(added.id);
    setFocus((current) => ({ ...current, selectedNodeId: added.id }));
  };

  const selectedTable = isErd && diagram && focus.selectedNodeId ? diagram.nodes.find((node) => node.id === focus.selectedNodeId) : undefined;
  const isOutdated = Boolean(diagram) && Boolean(status?.isOutdated);
  const generatedAt = status?.generatedAt ? new Date(status.generatedAt).toLocaleString() : null;
  const hint = isGeneratingGraph
    ? "Generating…"
    : diagram === null
      ? `No ${typeName} diagram yet`
      : problems.length
        ? "Parts of the agent's diagram do not match the schema and are left out; update the diagram to get them."
        : isOutdated
          ? "Files changed since the diagram was generated"
          : null;
  const emptyText = diagram
    ? "The diagram has no elements; update it to fill it."
    : isErd
      ? "Generate the ERD from the session's changes, or add a table to start one by hand."
      : `Generate the ${typeName} diagram to see it here.`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-(--line) px-3 py-2.5 text-[13px]">
        <DiagramTypeDropdown sessionId={sessionId} />
        <GenerateSplitButton
          label={isGeneratingGraph ? "Generating…" : diagram ? "Update diagram" : "Generate diagram"}
          isDisabled={isGeneratingGraph}
          onGenerate={(instructions) => void refreshGraph(sessionId, diagramType, instructions)}
        />
        {isErd && diagram !== undefined ? (
          <button type="button" onClick={addNewTable} disabled={isGeneratingGraph} title="Add a table to the diagram" className={SECONDARY_BUTTON_XS}>
            <PlusIcon /> Table
          </button>
        ) : null}
        <span
          className={`flex min-w-0 flex-1 items-center gap-2 ${isGeneratingGraph ? "text-neutral-400" : problems.length || isOutdated ? "text-amber-300/90" : "text-neutral-500"}`}
          title={generatedAt ? `Diagram generated ${generatedAt}` : undefined}
        >
          {isGeneratingGraph ? <Spinner className="size-5 shrink-0" /> : null}
          {hint ? <span className="truncate">{hint}</span> : null}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <DiagramStatusBadge status={status} hasDiagram={Boolean(diagram)} />
          {error || generateError ? <p className="absolute inset-x-3 top-3 z-10 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[13px] text-red-300">{error ?? generateError}</p> : null}
          <ReactFlowProvider key={`${layoutVersion}:${zoomScale}`}>
            {diagram?.nodes.length ? (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={SHAPE_NODE_TYPES}
                edgeTypes={SHAPE_EDGE_TYPES}
                onEdgeMouseEnter={(_event, edge) => setFocus((current) => ({ ...current, hoveredEdgeId: edge.id }))}
                onEdgeMouseLeave={() => setFocus((current) => ({ ...current, hoveredEdgeId: null }))}
                onNodeMouseEnter={(_event, node) => {
                  if (node.type === "boundary") return;
                  setFocus((current) => ({ ...current, hoveredNodeId: node.id }));
                }}
                onNodeMouseLeave={() => setFocus((current) => ({ ...current, hoveredNodeId: null }))}
                onNodeClick={(_event, node) => {
                  if (!isErd || node.type !== "table") return;
                  setFocus((current) => ({ ...current, selectedNodeId: node.id }));
                }}
                onPaneClick={() => setFocus((current) => ({ ...current, selectedNodeId: null }))}
                fitView
                fitViewOptions={fitViewOptions}
                minZoom={0.2}
                maxZoom={2 * Math.max(1, zoomScale)}
                colorMode="dark"
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
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
          </ReactFlowProvider>
        </div>
        {selectedTable && diagram ? (
          <TableEditor
            key={selectedTable.id}
            diagram={diagram}
            table={selectedTable}
            isNew={selectedTable.id === createdId}
            onChange={applyEdit}
            onClose={() => setFocus((current) => ({ ...current, selectedNodeId: null }))}
          />
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
        {isErd && diagram?.nodes.length && !selectedTable ? <span className="shrink-0">Click a table to edit it</span> : null}
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
