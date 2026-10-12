import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, type EdgeTypes, type NodeTypes } from "@xyflow/react";
import { openInEditorWindow } from "../ide/editorWindows";
import { commands } from "../ipc/commands";
import type { ArchitectureGraph, ChangeStat, ChangedFile, GraphEdge, GraphStatus } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { STATUS_BAR } from "../ui/bars";
import { errorText, useLoad } from "../ui/useLoad";
import { PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { DependencyCard, type OutgoingDependency } from "./DependencyCard";
import { buildDiagram, litByHover, type DiagramNode } from "./diagram";
import { openDiffWindow } from "./diffWindows";
import { FileFilterPopover } from "./FileFilterPopover";
import { collectImportEdges } from "./imports";
import { edgeMarker, layoutDiagram, type DependencyEdge, type DiagramFlowNode } from "./layout";
import { AliasChip, DependencyEdgeView, FileNodeView, FolderGroupView, GraphActionsContext, REVIEW_LABELS, ReviewBars, type GraphActions } from "./nodes";
import { parseGraph } from "./schema";

const NODE_TYPES: NodeTypes = { file: FileNodeView, folder: FolderGroupView };
const EDGE_TYPES: EdgeTypes = { dependency: DependencyEdgeView };
const EMPTY_GRAPH: ArchitectureGraph = { nodes: [], edges: [] };

/**
 * Component diagram of the session's uncommitted changes: one node per changed file, sized by its changed lines,
 * with the imports read from the files and the dependencies the agent wrote to `.hunt/graph.json` as labeled
 * edges; hovering an edge shows what the dependency is used for, hovering a file lights up the files it depends on
 * and lists them in a card. Unchanged files the agent added for context are dimmed, and files of the same folder
 * share a translucent group area. A click on a changed file opens its diff in a window of its own; the "Files" popover hides files
 * from the diagram. Path prefixes many files share are replaced by a term, explained in the legend above the footer.
 */
export function GraphPanel({ sessionId }: { sessionId: string }) {
  const graphVersion = useHuntStore((state) => state.chats[sessionId]?.graphVersion ?? 0);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const isBusy = useHuntStore((state) => state.chats[sessionId]?.isBusy ?? false);
  const isLive = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId)?.isLive ?? false);
  const refreshGraph = useHuntStore((state) => state.refreshGraph);

  const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  /** When the diagram was generated and whether files changed since; refetched with the diagram and with every edit. */
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [stats, setStats] = useState<ChangeStat[]>([]);
  /** Edges read from the import statements of the changed files. */
  const [importEdges, setImportEdges] = useState<GraphEdge[]>([]);
  /** Changed files unchecked in the filter popover; new files start checked. */
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Path of the hovered file; the dependency card places itself next to its box. */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [showProblems, setShowProblems] = useState(false);
  /** Bumped when a layout lands so React Flow remounts and fits the diagram into view. */
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [nodes, setNodes, onNodesChange] = useNodesState<DiagramFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DependencyEdge>([]);

  useEffect(() => {
    setExcluded(new Set());
    setIsFilterOpen(false);
  }, [sessionId]);

  useLoad(
    () => commands.readGraph(sessionId),
    {
      onValue: (raw) => {
        if (raw === null || raw === undefined) {
          setGraph(null);
          setProblems([]);
        } else {
          const parsed = parseGraph(raw);
          setGraph(parsed.graph);
          setProblems(parsed.problems);
        }
        setError(null);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, graphVersion],
  );

  useLoad(() => commands.graphStatus(sessionId), { onValue: setStatus, onError: (reason) => setError(errorText(reason)) }, [sessionId, graphVersion, editVersion]);

  // The first changelist loads at once; reloads after edits wait, so a burst of them loads once.
  const hasLoadedRef = useRef(false);
  useLoad(
    () => {
      hasLoadedRef.current = true;
      return Promise.all([commands.listChangedFiles(sessionId), commands.changeStats(sessionId)]);
    },
    {
      onValue: ([changedFiles, changeStats]) => {
        setFiles(changedFiles);
        setStats(changeStats);
        setError(null);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, editVersion],
    { delayMs: hasLoadedRef.current ? 300 : 0 },
  );

  // Imports between changed files and the agent's context files; reread whenever the files or the graph change.
  useLoad(
    () => {
      const sources = files.map((file) => file.path);
      const targets = new Set([...sources, ...(graph ?? EMPTY_GRAPH).nodes.map((node) => node.path)]);
      return collectImportEdges(sessionId, sources, targets);
    },
    { onValue: setImportEdges, onError: (reason) => setError(errorText(reason)) },
    [sessionId, files, graph],
  );

  const diagram = useMemo(() => buildDiagram(graph ?? EMPTY_GRAPH, importEdges, files, stats, excluded), [graph, importEdges, files, stats, excluded]);

  useLoad(
    () => layoutDiagram(diagram),
    {
      onValue: (flow) => {
        setNodes(flow.nodes);
        setEdges(flow.edges);
        setLayoutVersion((version) => version + 1);
      },
      onError: (reason) => setError(`Layout failed: ${errorText(reason)}`),
    },
    [diagram, setNodes, setEdges],
  );

  // The hovered edge shows its description; it and the edges leaving the hovered file light up, together with
  // the hovered file and the files those edges point at, while every other edge fades. Edges arriving at the
  // hovered file stay as they are.
  const lit = useMemo(() => litByHover(diagram, hoveredId), [diagram, hoveredId]);
  useEffect(() => {
    const isAnythingHovered = Boolean(hoveredId || hoveredEdgeId);
    setEdges((current) =>
      current.map((edge) => {
        const isHovered = edge.id === hoveredEdgeId;
        const selected = isHovered || lit.edgeIds.has(edge.id);
        const isMuted = isAnythingHovered && !selected;
        return { ...edge, selected, markerEnd: edgeMarker(selected), data: edge.data ? { ...edge.data, isHovered, isMuted } : edge.data };
      }),
    );
  }, [hoveredId, hoveredEdgeId, lit, setEdges]);
  useEffect(() => {
    setNodes((current) => current.map((node) => (node.type === "file" ? { ...node, selected: lit.nodePaths.has(node.id) } : node)));
  }, [lit, setNodes]);

  /** The hovered file and the edges leaving it, each with the file it points at. */
  const hoveredNode = hoveredId ? (diagram.nodes.find((node) => node.path === hoveredId) ?? null) : null;
  const dependencies = useMemo<OutgoingDependency[]>(() => {
    if (!hoveredId) return [];
    const byPath = new Map(diagram.nodes.map((node) => [node.path, node]));
    return diagram.edges.filter((edge) => edge.source === hoveredId).map((edge) => ({ edge, target: byPath.get(edge.target) ?? null }));
  }, [hoveredId, diagram]);

  const actions = useMemo<GraphActions>(
    () => ({
      openDiff: (node) => void openDiffWindow(sessionId, node.path),
      openFile: (node) => void openInEditorWindow(sessionId, { path: node.path }),
    }),
    [sessionId],
  );

  /** A changed file shows its diff; a context file has none and opens in the editor window instead. */
  const activate = (node: DiagramNode) => {
    if (node.isChanged) {
      actions.openDiff(node);
    } else {
      actions.openFile(node);
    }
  };

  /** The agent wrote a file with schema problems and none of its edges reached the diagram; the edges fall back to the imports. */
  const agentPairs = useMemo(() => new Set((graph ?? EMPTY_GRAPH).edges.map((edge) => `${edge.source}->${edge.target}`)), [graph]);
  const isGraphUnusable = Boolean(graph) && problems.length > 0 && !diagram.edges.some((edge) => agentPairs.has(edge.id));
  /** Files of the worktree changed after the agent wrote the diagram, so its nodes and edges no longer match the changes. */
  const isOutdated = Boolean(graph) && Boolean(status?.isOutdated);
  const generatedAt = status?.generatedAt ? new Date(status.generatedAt).toLocaleString() : null;
  const hint = isGraphUnusable
    ? "The agent's diagram does not match the schema and is left out; update the diagram to get its labels."
    : isOutdated
      ? "Files changed since the diagram was generated; update it to match the current changes."
      : graph
        ? "Hover a file to see what it depends on, click it to see its diff."
        : "Edges show the imports between the changed files; generate the diagram for the agent's labels and context files.";

  const changedShown = diagram.nodes.filter((node) => node.isChanged).length;
  const contextShown = diagram.nodes.length - changedShown;
  const hasReviewRatings = diagram.nodes.some((node) => node.review);

  return (
    <GraphActionsContext.Provider value={actions}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-(--line) px-3 py-2.5 text-[13px]">
          <div className="relative">
            <button ref={filterButtonRef} type="button" onClick={() => setIsFilterOpen((value) => !value)} className={SECONDARY_BUTTON_XS} title="Choose which changed files the diagram shows">
              Files
              <span className="text-neutral-400">
                {diagram.hiddenCount ? `${files.length - diagram.hiddenCount}/${files.length}` : files.length}
              </span>
            </button>
            {isFilterOpen ? <FileFilterPopover files={files} excluded={excluded} onChange={setExcluded} onClose={() => setIsFilterOpen(false)} anchorRef={filterButtonRef} /> : null}
          </div>
          {isOutdated ? (
            <span
              className="shrink-0 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[12px] font-medium text-amber-300"
              title={generatedAt ? `Generated ${generatedAt}; files changed since.` : "Files changed since the diagram was generated."}
            >
              Outdated
            </span>
          ) : null}
          <span className={`min-w-0 flex-1 truncate ${isGraphUnusable || isOutdated ? "text-amber-300/90" : "text-neutral-500"}`} title={generatedAt ? `Diagram generated ${generatedAt}` : undefined}>
            {hint}
          </span>
          <button type="button" disabled={!isLive || isBusy} onClick={() => void refreshGraph(sessionId)} className={PRIMARY_BUTTON_XS}>
            {isBusy ? "Working…" : graph ? "Update diagram" : "Generate diagram"}
          </button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {error ? <p className="absolute inset-x-3 top-3 z-10 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[13px] text-red-300">{error}</p> : null}
          <ReactFlowProvider key={layoutVersion}>
            {diagram.nodes.length ? (
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onNodeClick={(_event, node) => node.type === "file" && activate(node.data)}
                onNodeMouseEnter={(_event, node) => node.type === "file" && setHoveredId(node.id)}
                onNodeMouseLeave={() => setHoveredId(null)}
                onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)}
                onEdgeMouseLeave={() => setHoveredEdgeId(null)}
                fitView
                fitViewOptions={{ padding: 0.1, minZoom: 0.6, maxZoom: 1.2 }}
                minZoom={0.2}
                colorMode="dark"
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={24} color="#2f343d" />
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
                {files.length ? "Every changed file is hidden by the filter." : "No uncommitted changes. The diagram shows the changed files of this session once there are some."}
              </div>
            )}
            {hoveredNode && dependencies.length ? <DependencyCard node={hoveredNode} dependencies={dependencies} lit={lit} /> : null}
          </ReactFlowProvider>
        </div>

        {showProblems && problems.length ? (
          <ul className="max-h-32 overflow-auto border-t border-(--line) bg-amber-500/5 px-3 py-2.5 text-[13px] text-amber-200/90">
            {problems.map((problem, position) => (
              <li key={position}>{problem}</li>
            ))}
          </ul>
        ) : null}

        {diagram.legend.length ? (
          <div className={`${STATUS_BAR} gap-4 font-mono text-neutral-500`}>
            {diagram.legend.map((entry) => (
              <span key={entry.alias} className="flex shrink-0 items-center gap-1.5" title={`${entry.alias} stands for ${entry.prefix}`}>
                <AliasChip alias={entry.alias} />
                <span>= {entry.prefix}</span>
              </span>
            ))}
          </div>
        ) : null}

        <div className={`${STATUS_BAR} gap-3 text-neutral-500`}>
          <span className="shrink-0">
            {changedShown} changed{diagram.hiddenCount ? ` (${diagram.hiddenCount} hidden)` : ""} · {contextShown} for context · {diagram.edges.length} dependencies
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
            <span className="flex shrink-0 items-center gap-1">
              <span className="inline-block h-2 w-3 rounded-sm border border-white/40 bg-(--surface-inset)" />
              changed, sized by changed lines
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="inline-block h-2 w-3 rounded-sm border border-dashed border-neutral-500 opacity-60" />
              unchanged, for context
            </span>
            {hasReviewRatings ? (
              <span className="flex shrink-0 items-center gap-1" title={`Review relevance rated by the agent: 1 ${REVIEW_LABELS[1]}, 4 ${REVIEW_LABELS[4]}.`}>
                <ReviewBars level={1} className="size-3" />
                <ReviewBars level={4} className="size-3" />
                review relevance, red to green
              </span>
            ) : null}
          </span>
          {problems.length ? (
            <button type="button" onClick={() => setShowProblems((value) => !value)} className="shrink-0 text-amber-300/90 hover:text-amber-200">
              {problems.length} schema {problems.length === 1 ? "problem" : "problems"}
            </button>
          ) : null}
        </div>
      </div>
    </GraphActionsContext.Provider>
  );
}
