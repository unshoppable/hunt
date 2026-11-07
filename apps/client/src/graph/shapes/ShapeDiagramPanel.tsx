import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, ConnectionLineType, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type FinalConnectionState, type ReactFlowInstance } from "@xyflow/react";
import { commands } from "../../ipc/commands";
import type { ShapeDiagramType } from "../../common/diagram/diagram.types";
import { diagramRunKey } from "../../common/diagram/diagram-file.utils";
import type { GraphStatus } from "../graph.types";
import type { ShapeDiagram, ShapeKind, ShapePosition, ShapeSelection } from "./shape-diagram.types";
import { DIAGRAM_FONT_SIZE, useSettingsStore } from "../../settings/settings.store";
import { useHuntStore } from "../../sessions/hunt.store";
import { STATUS_BAR } from "../../ui/bars.constants";
import { ChevronIcon } from "../../ui/Icons";
import { confirmDestructive } from "../../ui/confirm.utils";
import { useDismiss } from "../../ui/dismiss.hook";
import { useShortcutLabel } from "../../ui/shortcut-label.hook";
import { isShortcut } from "../../ui/shortcuts.utils";
import { SECONDARY_BUTTON_XS } from "../../ui/buttons.constants";
import { Spinner } from "../../ui/Icons";
import { useLoad } from "../../ui/load.hook";
import { errorText } from "../../ui/error-text.utils";
import { DiagramStatusBadge, DiagramTypeDropdown, GenerateSplitButton, SaveDiagramButton } from "../DiagramToolbar";
import { DIAGRAM_TYPES, KINDS_BY_TYPE } from "../diagram-types.constants";
import { addRelationship, addTable, emptyErd, serializeShapeDiagram } from "./erd-edit.utils";
import { addEdge, addGroup, addNode, clearPositions, deletionOf, emptyDiagram, setBends, setPositions } from "./shape-edit.utils";
import { placeWithoutOverlaps } from "./element-overlap.utils";
import { decorateShapeFlow, hasManualChanges, layoutShapeDiagram, portColumn, shapeNodeSize, type ShapeDiagramFlowNode, type ShapeFlowEdge, type ShapeFocus } from "./shape-diagram.utils";
import { CHANGE_EDGE_COLOR, CrowFootDefs, EdgeBendsContext, SHAPE_EDGE_TYPES, SHAPE_NODE_TYPES } from "./ShapeNodes";
import { parseShapeDiagram } from "./shape-schema.utils";
import { kindName, ShapeElementEditor } from "./ShapeElementEditor";
import { TableEditor } from "./TableEditor";
import { TableFilterPopover } from "./TableFilterPopover";
import { withoutTables } from "./table-filter.utils";
import { ShapeToolbar, type ShapeTool } from "./ShapeToolbar";

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
 * beside the canvas (the table editor for an ERD table). The tools floating at the bottom of the canvas (`ShapeToolbar`)
 * place an element of the picked kind where the canvas is clicked next, connect the two elements clicked next, add
 * boundaries and offer Auto-layout; dragging from the dot under an element (beside a column of an ERD table) connects
 * it too, and dragging an element fixes the positions of all of them until Auto-layout drops them again. The editor's
 * delete button, the context menu of an element, connection or boundary and Delete or Backspace on the selection
 * (`graph.deleteSelection`) delete it, asking first when more goes with it. Every edit shows at once and is written
 * back to the file shortly after. For a generated diagram the toolbar at the top also shows whether files changed since
 * it was generated, generates or updates it, and saves it into the repository, after which the tab shows the saved
 * file; nothing is generated without a click. An ERD's "Tables" button hides tables from the canvas, like the
 * dependency graph's "Files" button hides files; the file keeps them.
 */
export function ShapeDiagramPanel({ sessionId, source }: { sessionId: string; source: ShapeDiagramSource }) {
  const diagramType = source.type;
  const filePath = source.kind === "file" ? source.path : null;
  const graphVersion = useHuntStore((state) => state.chats[sessionId]?.graphVersion ?? 0);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const runKey = diagramRunKey(diagramType, filePath);
  const isGeneratingGraph = useHuntStore((state) => state.chats[sessionId]?.generatingDiagrams.includes(runKey) ?? false);
  const generateError = useHuntStore((state) => state.chats[sessionId]?.diagramErrors[runKey] ?? null);
  const refreshGraph = useHuntStore((state) => state.refreshGraph);
  const setDiagramFile = useSettingsStore((state) => state.setDiagramFile);
  const typeName = DIAGRAM_TYPES.find((type) => type.id === diagramType)?.name ?? diagramType;
  const isErd = diagramType === "erd";

  /** Undefined until the file was read, null when there is none. */
  const [diagram, setDiagram] = useState<ShapeDiagram | null | undefined>(undefined);
  /** ERD tables unchecked in the table filter, remembered per session; they and their relationships stay off the canvas. */
  const hiddenTableIds = useSettingsStore((state) => (isErd ? state.erdHiddenTables[sessionId] : undefined));
  const hiddenTables = useMemo(() => new Set(hiddenTableIds), [hiddenTableIds]);
  const setErdHiddenTables = useSettingsStore((state) => state.setErdHiddenTables);
  const [isTableFilterOpen, setIsTableFilterOpen] = useState(false);
  const tableFilterButtonRef = useRef<HTMLButtonElement>(null);
  /** What the canvas lays out; every edit applies to the whole `diagram`. */
  const shownDiagram = useMemo(() => (diagram && hiddenTables.size ? withoutTables(diagram, hiddenTables) : diagram), [diagram, hiddenTables]);
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
  /** The context menu of the element, connection or boundary right-clicked last, at the pointer. */
  const [menu, setMenu] = useState<{ target: ShapeSelection; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, () => setMenu(null), { closeOnWindowBlur: true, isEnabled: Boolean(menu) });
  const deleteShortcut = useShortcutLabel("graph.deleteSelection");
  /**
   * Bumped when a diagram with other elements is loaded, so React Flow remounts and fits it into view; the user's own
   * edits keep the view. A mount without elements does not fit, or the first element placed would move the view.
   */
  const [view, setView] = useState({ version: 0, fits: false });
  /** True while `diagram` comes from the user's own edit rather than from the file. */
  const isOwnEditRef = useRef(false);
  const [tool, setTool] = useState<ShapeTool>("select");
  /** The element a connection starts at, clicked first with the connect tool. */
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
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
            isOwnEditRef.current = false;
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
    () => (filePath ? commands.diagramFileStatus(sessionId, filePath) : commands.graphStatus(sessionId, diagramType)),
    { onValue: setStatus, onError: (reason) => setError(errorText(reason)) },
    [sessionId, diagramType, filePath, graphVersion, editVersion],
  );

  useLoad(
    (signal) => (shownDiagram ? layoutShapeDiagram(shownDiagram, signal) : Promise.resolve({ nodes: [], edges: [] })),
    {
      onValue: (flow) => {
        layoutRef.current = flow;
        const decorated = decorateShapeFlow(flow.nodes, flow.edges, focus, isErd);
        setNodes(decorated.nodes);
        setEdges(decorated.edges);
        const elementIds = flow.nodes.map((node) => node.id).join("\n");
        if (elementIds !== elementIdsRef.current) {
          elementIdsRef.current = elementIds;
          if (!isOwnEditRef.current) {
            setView((current) => ({ version: current.version + 1, fits: flow.nodes.length > 0 }));
          }
        }
      },
      onError: (reason) => setError(`Layout failed: ${errorText(reason)}`),
    },
    [shownDiagram, isErd, setNodes, setEdges],
  );

  // The flags follow the mouse and the selection without a new layout. They go onto the nodes React Flow holds, which
  // carry their measured size: fresh copies of the laid out nodes would count as unmeasured, and React Flow would
  // unmount every edge until it measured them again, so each hover would route every edge anew.
  useEffect(() => {
    const focus = { hoveredEdgeId, hoveredNodeId, selectedNodeId, selectedEdgeId };
    setNodes((current) => decorateShapeFlow(current, layoutRef.current.edges, focus, isErd).nodes);
    setEdges(decorateShapeFlow([], layoutRef.current.edges, focus, isErd).edges);
  }, [hoveredEdgeId, hoveredNodeId, selectedNodeId, selectedEdgeId, isErd, setNodes, setEdges]);

  /** Shows `next` at once and writes it to the diagram file after `WRITE_DELAY_MS`; the reload it triggers is recognised and skipped. */
  const applyEdit = useCallback(
    (next: ShapeDiagram) => {
      const serialized = serializeShapeDiagram(next);
      serializedRef.current = serialized;
      isOwnEditRef.current = true;
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

  /** Deletes `target` after asking when more goes with it; the editor closes when it showed `target`. */
  const deleteElement = useCallback(
    async (target: ShapeSelection) => {
      const deletion = diagram ? deletionOf(diagram, target) : null;
      if (!deletion || (deletion.question && !(await confirmDestructive(deletion.question)))) return;
      applyEdit(deletion.diagram);
      setSelection((current) => (current?.kind === target.kind && current.id === target.id ? null : current));
    },
    [diagram, applyEdit],
  );

  // Delete and Backspace delete the selection while the focus is on the canvas or nowhere, never while typing in a field.
  useEffect(() => {
    if (!selection) return;
    const selected = selection;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isShortcut(event, "graph.deleteSelection")) return;
      const target = event.target;
      if (target !== document.body && !(target instanceof Node && canvasRef.current?.contains(target))) return;
      event.preventDefault();
      void deleteElement(selected);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, deleteElement]);

  const openMenu = (event: React.MouseEvent, target: ShapeSelection) => {
    event.preventDefault();
    setMenu({ target, x: event.clientX, y: event.clientY });
  };

  const changeTool = useCallback((next: ShapeTool) => {
    setTool(next);
    setConnectFrom(null);
  }, []);

  /** Places an element of `kind` centred on the clicked `point` of the canvas and opens its editor; the tool returns to select. */
  const placeElement = (kind: ShapeKind, point: { x: number; y: number }) => {
    if (!flowRef.current) return;
    const center = flowRef.current.screenToFlowPosition(point);
    const label = kind === "table" ? "new_table" : `New ${kindName(diagramType, kind).toLowerCase()}`;
    const added = kind === "table" ? addTable(diagram ?? emptyErd(), label) : addNode(diagram ?? emptyDiagram(diagramType), kind, label);
    const node = added.diagram.nodes.find((candidate) => candidate.id === added.id);
    const size = node ? shapeNodeSize(node) : { width: 0, height: 0 };
    const position = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
    applyEdit(setPositions(added.diagram, new Map([[added.id, position]])));
    select({ kind: "node", id: added.id }, true);
    changeTool("select");
  };

  /** With the connect tool, the first click picks where the connection starts, the second where it ends. */
  const connectClicked = (nodeId: string) => {
    if (!diagram) return;
    if (!connectFrom || connectFrom === nodeId) {
      setConnectFrom(nodeId);
      return;
    }
    const added = addEdge(diagram, connectFrom, nodeId);
    changeTool("select");
    if (!added.id) return;
    applyEdit(added.diagram);
    select({ kind: "edge", id: added.id }, true);
  };

  const addNewGroup = () => {
    const added = addGroup(diagram ?? emptyDiagram(diagramType), "New boundary");
    applyEdit(added.diagram);
    select({ kind: "group", id: added.id }, true);
  };

  /** Fixes the corners of the connection `edgeId` whose segment the user moved, or lets Hunt route it again. */
  const moveConnection = (edgeId: string, bends: ShapePosition[] | null) => {
    if (diagram) applyEdit(setBends(diagram, edgeId, bends));
  };

  /**
   * Fixes every element where it is now, so the ones just dragged stay where they were dropped; dropped onto another
   * element, they move aside to the nearest free spot.
   */
  const keepPositions = (droppedIds: ReadonlySet<string>) => {
    if (!diagram) return;
    const boundaries = new Map(nodes.filter((node) => node.type === "boundary").map((node) => [node.id, node.position]));
    const boxes = nodes
      .filter((node) => node.type !== "boundary")
      .map((node) => {
        const origin = node.parentId ? (boundaries.get(node.parentId) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
        return { id: node.id, x: origin.x + node.position.x, y: origin.y + node.position.y, width: node.width ?? 0, height: node.height ?? 0 };
      });
    const positions = placeWithoutOverlaps([...boxes.filter((box) => !droppedIds.has(box.id)), ...boxes.filter((box) => droppedIds.has(box.id))]);
    applyEdit(setPositions(diagram, positions));
  };

  /**
   * Connects the element a connection was dragged from to the element it was dropped on, a handle or anywhere on it.
   * An ERD relationship starts at the column whose dot it was dragged from and ends at the column of the handle it
   * snapped to, else at the row under the pointer, else at the target table's first primary key or first column.
   */
  const connect = (event: MouseEvent | TouchEvent, connection: FinalConnectionState) => {
    if (!diagram || !connection.fromNode) return;
    const source = connection.fromNode.id;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const pointed = point ? document.elementFromPoint(point.clientX, point.clientY) : null;
    const dropped = pointed?.closest(".react-flow__node")?.getAttribute("data-id");
    const target = connection.toNode?.id ?? dropped;
    if (!target) return;
    let added: { diagram: ShapeDiagram; id: string | null };
    if (isErd) {
      const fromTable = diagram.nodes.find((node) => node.id === source);
      const toTable = diagram.nodes.find((node) => node.id === target);
      const sourceColumn = fromTable && portColumn(fromTable, connection.fromHandle?.id)?.name;
      const pointedColumn = target === dropped ? pointed?.closest("[data-column]")?.getAttribute("data-column") : null;
      const fallbackColumn = toTable?.columns?.find((column) => column.isPrimaryKey) ?? toTable?.columns?.[0];
      const targetColumn = toTable && (portColumn(toTable, connection.toHandle?.id)?.name ?? pointedColumn ?? fallbackColumn?.name);
      if (!sourceColumn || !targetColumn) return;
      added = addRelationship(diagram, { table: source, column: sourceColumn }, { table: target, column: targetColumn });
    } else {
      added = addEdge(diagram, source, target);
    }
    if (!added.id) return;
    applyEdit(added.diagram);
    select({ kind: "edge", id: added.id }, true);
  };

  /** Hides the tables `next` names, keeping only ids the diagram still has; the editor closes when its table goes. */
  const hideTables = (next: ReadonlySet<string>) => {
    const ids = diagram?.nodes.filter((node) => next.has(node.id)).map((node) => node.id) ?? [];
    setErdHiddenTables(sessionId, ids);
    setSelection((current) => (current?.kind === "node" && next.has(current.id) ? null : current));
  };

  const shownTableCount = shownDiagram?.nodes.length ?? 0;
  const selectedNode = diagram && selection?.kind === "node" ? diagram.nodes.find((node) => node.id === selection.id) : undefined;
  const menuLabel = !menu
    ? ""
    : menu.target.kind === "group"
      ? "Delete boundary"
      : menu.target.kind === "edge"
        ? isErd
          ? "Delete relationship"
          : "Delete connection"
        : diagram?.nodes.find((node) => node.id === menu.target.id)?.kind === "table"
          ? "Delete table"
          : "Delete element";
  const hasManualEdits = diagram ? hasManualChanges(diagram) : false;
  const generatedAt = status?.generatedAt ? new Date(status.generatedAt).toLocaleString() : null;
  const hint = isGeneratingGraph
    ? "Generating…"
    : filePath
      ? null
      : diagram === null
        ? `No ${typeName} diagram yet`
        : problems.length
          ? "Parts of the agent's diagram do not match the schema and are left out; update the diagram to get them."
          : null;
  const emptyText = diagram?.nodes.length
    ? "Every table is hidden; check some under Tables to show them."
    : diagram
    ? "The diagram has no elements; pick a tool below and click here to place one, or update the diagram to fill it."
    : isErd
      ? "Generate the ERD from the session's changes, or pick the table tool below and click here to start one by hand."
      : diagramType === "freeform"
        ? "Pick a shape below and click here to start drawing, or generate a sketch from additional instructions."
        : `Generate the ${typeName} diagram, or pick an element below and click here to start one by hand.`;
  const isPlacing = tool !== "select" && tool !== "connect";
  const toolHint = isPlacing
    ? `Click the canvas to place the ${kindName(diagramType, tool).toLowerCase()} · Esc cancels`
    : tool === "connect"
      ? `${connectFrom ? "Click the element the connection ends at" : "Click the element the connection starts at"} · Esc cancels`
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-(--line) px-3 py-2.5 text-[13px]">
        <DiagramTypeDropdown sessionId={sessionId} />
        <GenerateSplitButton
          label={isGeneratingGraph ? "Generating…" : diagram ? "Update diagram" : "Generate diagram"}
          isDisabled={isGeneratingGraph}
          title={
            filePath
              ? "Rewrites this file from the files it was derived from"
              : diagram
                ? "Overwrites the generated diagram; save it into the repository first to keep this version"
                : undefined
          }
          onGenerate={(instructions) => void refreshGraph(sessionId, diagramType, instructions, filePath)}
        />
        {!filePath && diagram?.nodes.length ? (
          <SaveDiagramButton sessionId={sessionId} diagram={diagram} content={() => serializeShapeDiagram(diagram)} onSaved={(path) => setDiagramFile(sessionId, path)} />
        ) : null}
        {isErd && diagram?.nodes.length ? (
          <div className="relative">
            <button
              ref={tableFilterButtonRef}
              type="button"
              onClick={() => setIsTableFilterOpen((value) => !value)}
              aria-haspopup="dialog"
              aria-expanded={isTableFilterOpen}
              className={SECONDARY_BUTTON_XS}
              title="Choose which tables the diagram shows"
            >
              Tables
              <span className="text-neutral-400">{shownTableCount < diagram.nodes.length ? `${shownTableCount}/${diagram.nodes.length}` : diagram.nodes.length}</span>
              <ChevronIcon expanded className="size-3 text-neutral-400" />
            </button>
            {isTableFilterOpen ? (
              <TableFilterPopover
                tables={diagram.nodes}
                hidden={hiddenTables}
                onChange={hideTables}
                onClose={() => setIsTableFilterOpen(false)}
                anchorRef={tableFilterButtonRef}
              />
            ) : null}
          </div>
        ) : null}
        <span
          className={`flex min-w-0 flex-1 items-center gap-2 ${isGeneratingGraph ? "text-neutral-400" : problems.length ? "text-amber-300/90" : "text-neutral-500"}`}
          title={generatedAt ? `Diagram generated ${generatedAt}` : undefined}
        >
          {isGeneratingGraph ? <Spinner className="size-5 shrink-0" /> : null}
          {hint ? <span className="truncate">{hint}</span> : null}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div ref={canvasRef} tabIndex={-1} className="relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none">
          <DiagramStatusBadge status={status} hasDiagram={Boolean(diagram)} filePath={filePath} hasSources={Boolean(diagram?.sources?.some((source) => source.hash))} />
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
          <ReactFlowProvider key={`${view.version}:${zoomScale}`}>
            <EdgeBendsContext.Provider value={moveConnection}>
            {diagram !== undefined ? (
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
                onNodeClick={(_event, node) => {
                  if (tool === "connect" && node.type !== "boundary") {
                    connectClicked(node.id);
                  } else {
                    select({ kind: node.type === "boundary" ? "group" : "node", id: node.id });
                  }
                }}
                onEdgeClick={(_event, edge) => select({ kind: "edge", id: edge.id })}
                onNodeContextMenu={(event, node) => openMenu(event, { kind: node.type === "boundary" ? "group" : "node", id: node.id })}
                onEdgeContextMenu={(event, edge) => openMenu(event, { kind: "edge", id: edge.id })}
                onPaneContextMenu={(event) => event.preventDefault()}
                onMoveStart={() => setMenu(null)}
                onPaneClick={(event) => {
                  if (isPlacing) {
                    placeElement(tool, { x: event.clientX, y: event.clientY });
                  } else {
                    setSelection(null);
                    setConnectFrom(null);
                  }
                }}
                onNodeDragStop={(_event, node, dropped) => {
                  // A press without a move keeps the automatic layout.
                  const before = layoutRef.current.nodes.find((candidate) => candidate.id === node.id)?.position;
                  if (before && before.x === node.position.x && before.y === node.position.y) return;
                  keepPositions(new Set(dropped.map((candidate) => candidate.id)));
                }}
                onConnectEnd={connect}
                connectionLineType={isErd ? ConnectionLineType.SmoothStep : undefined}
                fitView={view.fits}
                fitViewOptions={fitViewOptions}
                minZoom={0.2}
                maxZoom={2 * Math.max(1, zoomScale)}
                colorMode="dark"
                className={`${isErd ? "erd-canvas-editable" : "shape-canvas-editable"} ${isPlacing || tool === "connect" ? "shape-canvas-picking" : ""}`}
                nodesDraggable
                nodesConnectable
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
            ) : null}
            {diagram !== undefined && !shownDiagram?.nodes.length ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-neutral-500">{emptyText}</div>
            ) : null}
            </EdgeBendsContext.Provider>
          </ReactFlowProvider>
          {diagram !== undefined && !error ? (
            <ShapeToolbar
              diagramType={diagramType}
              kinds={KINDS_BY_TYPE[diagramType]}
              tool={tool}
              onToolChange={changeTool}
              onAddBoundary={diagramType === "c4-context" || diagramType === "c4-container" || diagramType === "freeform" ? addNewGroup : undefined}
              onAutoLayout={hasManualEdits ? () => diagram && applyEdit(clearPositions(diagram)) : undefined}
              isDisabled={isGeneratingGraph}
              canvasRef={canvasRef}
            />
          ) : null}
        </div>
        {diagram && selection ? (
          isErd && selectedNode?.kind === "table" ? (
            <TableEditor
              key={selectedNode.id}
              diagram={diagram}
              table={selectedNode}
              isNew={selectedNode.id === createdId}
              onChange={applyEdit}
              onDelete={() => void deleteElement(selection)}
              onClose={() => setSelection(null)}
            />
          ) : (
            <ShapeElementEditor
              key={`${selection.kind}:${selection.id}`}
              diagram={diagram}
              selection={selection}
              isNew={selection.id === createdId}
              onChange={applyEdit}
              onDelete={() => void deleteElement(selection)}
              onClose={() => setSelection(null)}
            />
          )
        ) : null}
      </div>

      {menu ? (
        <div ref={menuRef} role="menu" style={{ left: menu.x, top: menu.y }} className="fixed z-50 min-w-36 rounded border border-neutral-600 bg-(--surface-inset) p-1 text-[13px] shadow-lg">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void deleteElement(menu.target);
            }}
            className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-left text-red-300 hover:bg-(--row-hover)"
          >
            {menuLabel}
            {deleteShortcut ? <span className="text-neutral-500">{deleteShortcut}</span> : null}
          </button>
        </div>
      ) : null}

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
          {isErd
            ? `${diagram?.nodes.length ?? 0} tables${hiddenTables.size && diagram ? ` (${diagram.nodes.length - shownTableCount} hidden)` : ""} · ${diagram?.edges.length ?? 0} relationships` : `${diagram?.nodes.length ?? 0} elements · ${diagram?.edges.length ?? 0} connections`}
        </span>
        {toolHint ? (
          <span className="shrink-0 text-neutral-300">{toolHint}</span>
        ) : diagram?.nodes.length && !selection ? (
          <span className="shrink-0">{isErd
              ? "Click a table to edit it, drag it or a line to move it, drag from the dot beside a column onto another table to relate them"
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
