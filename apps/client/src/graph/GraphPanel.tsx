import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type EdgeTypes, type NodeTypes } from "@xyflow/react";
import { openInEditorWindow } from "../ide/editor-window.utils";
import { commands } from "../ipc/commands";
import type { ChangedFile } from "../common/changes/changed-file.types";
import type { ChangeStat } from "../diff/diff.types";
import type { ArchitectureGraph, GraphEdge, GraphStatus } from "./graph.types";
import { splitGlobs } from "../common/glob/glob.utils";
import { DIAGRAM_FONT_SIZE, useSettingsStore } from "../settings/settings.store";
import { useHuntStore } from "../sessions/hunt.store";
import { STATUS_BAR } from "../ui/bars.constants";
import { ChevronIcon, Spinner } from "../ui/Icons";
import { useHoverAnchor } from "../ui/hover-anchor.hook";
import { isShortcut } from "../ui/shortcuts.utils";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";
import { useReviewCommentCounts } from "../review/review-comments.hook";
import { SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { DependencyCard, type OutgoingDependency } from "./dependencies/DependencyCard";
import { buildDiagram, litByHover, type DiagramNode } from "./diagram.utils";
import { DiagramStatusBadge, DiagramTypeDropdown, GenerateSplitButton } from "./DiagramToolbar";
import { openDiffWindow } from "../diff/diff-window.utils";
import { FileFilterPopover } from "./FileFilterPopover";
import { GraphFilters } from "./GraphFilters";
import { GraphSearchField } from "./GraphSearchField";
import { readIdentifiers, searchDiagramFiles } from "./graph-search.utils";
import { collectImportEdges } from "./imports.utils";
import { edgeMarker, layoutDiagram, type DependencyEdge, type DiagramFlowNode } from "./layout.utils";
import { AliasChip, CommentCountsContext, DependencyEdgeView, FileNodeView, FolderGroupView, SearchHighlightContext, fileNodeMinWidth, type SearchHighlight } from "./DiagramNodes";
import { REVIEW_LABELS, ReviewBars } from "./ReviewBars";
import { parseGraph } from "./schema.utils";

const NODE_TYPES: NodeTypes = { file: FileNodeView, folder: FolderGroupView };
const EDGE_TYPES: EdgeTypes = { dependency: DependencyEdgeView };
const EMPTY_GRAPH: ArchitectureGraph = { nodes: [], edges: [] };
/** How long the mouse rests on a file before it counts as hovered; crossing a file on the way to the card does not. */
const FILE_HOVER_DELAY = 100;

/**
 * The Dependencies view of the Architecture tab: a component diagram of the session's changes against its diff base (with a reviewed pull request, its commits
 * plus the uncommitted changes), one node per changed file, sized by its changed lines,
 * with the imports read from the files and the dependencies the agent wrote to `.hunt/graph.json` as labeled
 * edges; hovering an edge shows what the dependency is used for, hovering a file lights up the files it depends on
 * and lists them in a card. Unchanged files the agent added for context are dimmed, and files of the same folder
 * share a translucent group area. A click on a changed file opens its diff in a window of its own; the "Files" popover hides files
 * from the diagram, the relevance and glob filters beside it hide files by the agent's review rating and by path. Directories read as their module and a shortened folder path, the full path shows on hover; the
 * legend above the footer lists the modules' root folders. The agent generates the diagram only on a click on the generate button.
 * ⌘F opens a search over the paths and the symbols of the diagram's files that highlights the matches and moves the view to them.
 */
export function GraphPanel({ sessionId }: { sessionId: string }) {
  const graphVersion = useHuntStore((state) => state.chats[sessionId]?.graphVersion ?? 0);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const isGeneratingGraph = useHuntStore((state) => state.chats[sessionId]?.generatingDiagrams.includes("dependencies") ?? false);
  const generateError = useHuntStore((state) => state.chats[sessionId]?.diagramErrors.dependencies ?? null);
  const refreshGraph = useHuntStore((state) => state.refreshGraph);
  const graphFilter = useSettingsStore((state) => state.graphFilter);

  /** Undefined until `graph.json` was read, null when there is none. */
  const [graph, setGraph] = useState<ArchitectureGraph | null | undefined>(undefined);
  const [problems, setProblems] = useState<string[]>([]);
  /** When the diagram was generated and whether files changed since; refetched with the diagram and with every edit. */
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [stats, setStats] = useState<ChangeStat[]>([]);
  /** Edges read from the import statements of the changed files. */
  const [importEdges, setImportEdges] = useState<GraphEdge[]>([]);
  /** Changed files unchecked in the filter popover, remembered per session; new files start checked. */
  const excludedPaths = useSettingsStore((state) => state.graphExcludedFiles[sessionId]);
  const excluded = useMemo(() => new Set(excludedPaths), [excludedPaths]);
  const setGraphExcludedFiles = useSettingsStore((state) => state.setGraphExcludedFiles);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The hovered file; the dependency card places itself next to its box and stays while the mouse is on the card. */
  const fileHover = useHoverAnchor<string>(FILE_HOVER_DELAY);
  const hoveredId = fileHover.anchor?.key ?? null;
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [showProblems, setShowProblems] = useState(false);
  /** Bumped when a layout lands so React Flow remounts and fits the diagram into view. */
  const [layoutVersion, setLayoutVersion] = useState(0);
  /** The node text is `DIAGRAM_FONT_SIZE` px at 100 % zoom; the diagram opens zoomed so it shows at the Architecture pane's font size. */
  const zoomScale = useSettingsStore((state) => state.panes.architecture.fontSize) / DIAGRAM_FONT_SIZE;
  const fitViewOptions = { padding: 0.1, minZoom: 0.6 * zoomScale, maxZoom: 1.2 * zoomScale };
  const [nodes, setNodes, onNodesChange] = useNodesState<DiagramFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DependencyEdge>([]);
  const commentCounts = useReviewCommentCounts(sessionId);
  /** The text of the ⌘F search; null while it is closed. */
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [activeMatch, setActiveMatch] = useState<string | null>(null);
  /** Identifiers in the content of each file of the diagram, read while the search is open. */
  const [identifiersByPath, setIdentifiersByPath] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isSearchOpen = searchQuery !== null;

  useEffect(() => {
    setIsFilterOpen(false);
  }, [sessionId]);

  useLoad(
    () => commands.readGraph(sessionId, "dependencies"),
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

  useLoad(() => commands.graphStatus(sessionId, "dependencies"), { onValue: setStatus, onError: (reason) => setError(errorText(reason)) }, [sessionId, graphVersion, editVersion]);

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

  const diagramFilter = useMemo(() => ({ minReview: graphFilter.minReview, hiddenGlobs: splitGlobs(graphFilter.hiddenGlobs) }), [graphFilter]);
  const diagram = useMemo(
    () => buildDiagram(graph ?? EMPTY_GRAPH, importEdges, files, stats, excluded, diagramFilter, fileNodeMinWidth),
    [graph, importEdges, files, stats, excluded, diagramFilter],
  );
  const checkedCount = files.filter((file) => !excluded.has(file.path)).length;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isShortcut(event, "graph.find")) return;
      event.preventDefault();
      setSearchQuery((query) => query ?? "");
      requestAnimationFrame(() => searchInputRef.current?.select());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const diagramPaths = useMemo(() => diagram.nodes.map((node) => node.path), [diagram]);
  useLoad(
    () => readIdentifiers(sessionId, diagramPaths),
    { onValue: setIdentifiersByPath, onError: (reason) => setError(errorText(reason)) },
    [sessionId, diagramPaths, editVersion, isSearchOpen],
    { isEnabled: isSearchOpen },
  );
  const deferredQuery = useDeferredValue(searchQuery ?? "");
  const searchMatches = useMemo(() => searchDiagramFiles(diagramPaths, identifiersByPath, deferredQuery), [diagramPaths, identifiersByPath, deferredQuery]);
  const searchHighlight = useMemo(() => (isSearchOpen && searchMatches ? { matches: searchMatches, activePath: activeMatch } : null), [isSearchOpen, searchMatches, activeMatch]);
  const closeSearch = useCallback(() => {
    setSearchQuery(null);
    setActiveMatch(null);
  }, []);

  useLoad(
    (signal) => layoutDiagram(diagram, signal),
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

  /** A changed file shows its diff; a context file has none and opens in the editor window instead. */
  const activate = (node: DiagramNode) => {
    if (node.isChanged) {
      void openDiffWindow(sessionId, node.path);
    } else {
      void openInEditorWindow(sessionId, { path: node.path });
    }
  };

  /** The agent wrote a file with schema problems and none of its edges reached the diagram; the edges fall back to the imports. */
  const agentPairs = useMemo(() => new Set((graph ?? EMPTY_GRAPH).edges.map((edge) => `${edge.source}->${edge.target}`)), [graph]);
  const isGraphUnusable = Boolean(graph) && problems.length > 0 && !diagram.edges.some((edge) => agentPairs.has(edge.id));
  /** Files of the worktree changed after the agent wrote the diagram, so its nodes and edges no longer match the changes. */
  const isOutdated = Boolean(graph) && Boolean(status?.isOutdated);
  const generatedAt = status?.generatedAt ? new Date(status.generatedAt).toLocaleString() : null;
  const hint = isGeneratingGraph
    ? "The agent is generating the diagram; its labels, review ratings and context files appear when it is done."
    : isGraphUnusable
      ? "The agent's diagram does not match the schema and is left out; update the diagram to get its labels."
      : isOutdated
        ? "Files changed since the diagram was generated; update it to match the current changes."
        : graph
          ? null
          : "Edges show the imports between the changed files; generate the diagram for the agent's labels, review ratings and context files.";

  const changedShown = diagram.nodes.filter((node) => node.isChanged).length;
  const contextShown = diagram.nodes.length - changedShown;
  const hasReviewRatings = diagram.nodes.some((node) => node.review);
  const isRated = Boolean(graph?.nodes.some((node) => node.review));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-(--line) px-3 py-2.5 text-[13px]">
        <DiagramTypeDropdown sessionId={sessionId} />
        <GenerateSplitButton
          label={isGeneratingGraph ? "Generating…" : graph ? "Update diagram" : "Generate diagram"}
          isDisabled={isGeneratingGraph}
          onGenerate={(instructions) => void refreshGraph(sessionId, "dependencies", instructions)}
        />
        <div className="relative">
          <button
            ref={filterButtonRef}
            type="button"
            onClick={() => setIsFilterOpen((value) => !value)}
            aria-haspopup="dialog"
            aria-expanded={isFilterOpen}
            className={SECONDARY_BUTTON_XS}
            title="Choose which changed files the diagram shows"
          >
            Files
            <span className="text-neutral-400">
              {checkedCount < files.length ? `${checkedCount}/${files.length}` : files.length}
            </span>
            <ChevronIcon expanded className="size-3 text-neutral-400" />
          </button>
          {isFilterOpen ? (
            <FileFilterPopover files={files} excluded={excluded} onChange={(next) => setGraphExcludedFiles(sessionId, [...next])} onClose={() => setIsFilterOpen(false)} anchorRef={filterButtonRef} />
          ) : null}
        </div>
        <GraphFilters hasRatings={isRated} />
        <span
          className={`flex min-w-0 flex-1 items-center gap-2 ${isGeneratingGraph ? "text-neutral-400" : isGraphUnusable || isOutdated ? "text-amber-300/90" : "text-neutral-500"}`}
          title={generatedAt ? `Diagram generated ${generatedAt}` : undefined}
        >
          {isGeneratingGraph ? <Spinner className="size-5 shrink-0" /> : null}
          {hint ? <span className="truncate">{hint}</span> : null}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <DiagramStatusBadge status={status} hasDiagram={Boolean(graph)} />
        {error || generateError ? <p className="absolute inset-x-3 top-3 z-10 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[13px] text-red-300">{error ?? generateError}</p> : null}
        <ReactFlowProvider key={`${layoutVersion}:${zoomScale}`}>
          {diagram.nodes.length ? (
            <CommentCountsContext value={commentCounts}>
              <SearchHighlightContext value={searchHighlight}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  nodeTypes={NODE_TYPES}
                  edgeTypes={EDGE_TYPES}
                  onNodeClick={(_event, node) => node.type === "file" && activate(node.data)}
                  onNodeMouseEnter={(event, node) => node.type === "file" && fileHover.enter(node.id, event.currentTarget as HTMLElement)}
                  onNodeMouseLeave={(_event, node) => node.type === "file" && fileHover.leave()}
                  onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)}
                  onEdgeMouseLeave={() => setHoveredEdgeId(null)}
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
                  <Background gap={24} color="#2f343d" />
                  <Controls showInteractive={false} fitViewOptions={fitViewOptions} />
                  <DiagramMiniMap searchHighlight={searchHighlight} />
                </ReactFlow>
              </SearchHighlightContext>
            </CommentCountsContext>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
              {files.length ? "Every changed file is hidden by the filters." : "No changes. The diagram shows the changed files of this session once there are some."}
            </div>
          )}
          {isSearchOpen && diagram.nodes.length ? (
            <GraphSearchField
              query={searchQuery}
              matches={searchMatches}
              activePath={activeMatch}
              minZoom={zoomScale}
              inputRef={searchInputRef}
              onQueryChange={setSearchQuery}
              onActivePathChange={setActiveMatch}
              onClose={closeSearch}
            />
          ) : null}
          {hoveredNode && dependencies.length ? (
            <DependencyCard
              node={hoveredNode}
              dependencies={dependencies}
              lit={lit}
              onMouseEnter={fileHover.keep}
              onMouseLeave={fileHover.leave}
              onOpen={activate}
            />
          ) : null}
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
  );
}

/** Overview of the whole diagram in the bottom-right corner: drag or scroll it to move and zoom the view, click to center there. Search matches show blue. */
function DiagramMiniMap({ searchHighlight }: { searchHighlight: SearchHighlight | null }) {
  const { getZoom, setCenter } = useReactFlow();
  return (
    <MiniMap<DiagramFlowNode>
      pannable
      zoomable
      ariaLabel="Diagram overview"
      nodeColor={(node) => (node.type === "file" && searchHighlight?.matches.has(node.id) ? "#60a5fa" : miniMapNodeColor(node))}
      nodeBorderRadius={4}
      maskStrokeWidth={1}
      onClick={(_event, position) => void setCenter(position.x, position.y, { zoom: getZoom(), duration: 200 })}
      className="overflow-hidden rounded-md border border-(--line)"
    />
  );
}

function miniMapNodeColor(node: DiagramFlowNode): string {
  if (node.type === "folder") return "rgba(255, 255, 255, 0.05)";
  return node.data.isChanged ? "#8a919e" : "#525967";
}
