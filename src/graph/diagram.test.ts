import { describe, expect, it } from "vitest";
import type { ArchitectureGraph, ChangeStat, ChangedFile } from "../ipc/types";
import { MAX_NODE_HEIGHT, MAX_NODE_WIDTH, MIN_NODE_HEIGHT, MIN_NODE_WIDTH, buildDiagram, buildLegend, litByHover, mergeEdges, nodeSize, shortenDirectory } from "./diagram";

const graph: ArchitectureGraph = {
  nodes: [{ path: "src/a.ts", description: "Entry.", review: 4, reviewReason: "Public entry point." }, { path: "src/lib/b.ts" }, { path: "src/lib/c.ts" }, { path: "src/lonely.ts" }],
  edges: [
    { source: "src/a.ts", target: "src/lib/b.ts", label: "uses b", description: "Calls b() for the main work." },
    { source: "src/lib/b.ts", target: "src/lib/c.ts", label: "uses c" },
    { source: "src/lonely.ts", target: "src/lib/c.ts", label: "uses c" },
  ],
};
const changed: ChangedFile[] = [
  { path: "src/a.ts", status: "M" },
  { path: "src/new.ts", status: "?" },
];
const stats: ChangeStat[] = [
  { path: "src/a.ts", added: 30, removed: 10 },
  { path: "src/new.ts", added: 10, removed: 0 },
];

describe("nodeSize", () => {
  it("grows with the square root of the share of changed lines", () => {
    expect(nodeSize(0, 100)).toEqual({ width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT });
    expect(nodeSize(100, 100)).toEqual({ width: MAX_NODE_WIDTH, height: MAX_NODE_HEIGHT });
    expect(nodeSize(25, 100).width).toBe(Math.round(MIN_NODE_WIDTH + (MAX_NODE_WIDTH - MIN_NODE_WIDTH) / 2));
    expect(nodeSize(5, 0)).toEqual({ width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT });
  });
});

describe("mergeEdges", () => {
  it("keeps the agent's label for a pair both sources know and adds the other import edges", () => {
    const merged = mergeEdges([{ source: "a", target: "b", label: "renders b" }], [
      { source: "a", target: "b", label: "UI component" },
      { source: "a", target: "c", label: "helpers" },
    ]);
    expect(merged).toEqual([
      { source: "a", target: "b", label: "renders b" },
      { source: "a", target: "c", label: "helpers" },
    ]);
  });

  it("takes the import label where the agent's label was repaired to the placeholder", () => {
    const merged = mergeEdges([{ source: "a", target: "b", label: "depends on", description: "Agent text." }], [{ source: "a", target: "b", label: "function calls" }]);
    expect(merged).toEqual([{ source: "a", target: "b", label: "function calls", description: "Agent text." }]);
  });
});

describe("buildDiagram", () => {
  it("draws import edges between changed files even without an agent graph", () => {
    const diagram = buildDiagram({ nodes: [], edges: [] }, [{ source: "src/a.ts", target: "src/new.ts", label: "fresh" }], changed, stats, new Set());
    expect(diagram.edges).toEqual([{ id: "src/a.ts->src/new.ts", source: "src/a.ts", target: "src/new.ts", label: "fresh" }]);
  });

  it("shows every changed file, the context files reachable from them and the edges between shown files", () => {
    const diagram = buildDiagram(graph, [], changed, stats, new Set());
    expect(diagram.nodes.map((node) => node.path)).toEqual(["src/a.ts", "src/new.ts", "src/lib/b.ts", "src/lib/c.ts", "src/lonely.ts"]);
    expect(diagram.edges.map((edge) => edge.id)).toEqual(["src/a.ts->src/lib/b.ts", "src/lib/b.ts->src/lib/c.ts", "src/lonely.ts->src/lib/c.ts"]);
    expect(diagram.edges.map((edge) => edge.description)).toEqual(["Calls b() for the main work.", undefined, undefined]);
    expect(diagram.nodes.map((node) => [node.review, node.reviewReason])).toEqual([[4, "Public entry point."], [undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined]]);
    expect(diagram.hiddenCount).toBe(0);
  });

  it("sizes changed files by their changed lines and keeps context files small", () => {
    const diagram = buildDiagram(graph, [], changed, stats, new Set());
    const byPath = new Map(diagram.nodes.map((node) => [node.path, node]));
    expect(byPath.get("src/a.ts")).toMatchObject({ isChanged: true, status: "M", added: 30, removed: 10, width: MAX_NODE_WIDTH, description: "Entry.", name: "a.ts", directory: "src", shortDirectory: null });
    expect(byPath.get("src/new.ts")!.width).toBeLessThan(MAX_NODE_WIDTH);
    expect(byPath.get("src/new.ts")!.width).toBeGreaterThan(MIN_NODE_WIDTH);
    expect(byPath.get("src/lib/b.ts")).toMatchObject({ isChanged: false, added: 0, removed: 0, width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT });
  });

  it("hides excluded changed files together with the context that only they reach", () => {
    const diagram = buildDiagram(graph, [], changed, stats, new Set(["src/a.ts"]));
    expect(diagram.nodes.map((node) => node.path)).toEqual(["src/new.ts"]);
    expect(diagram.edges).toEqual([]);
    expect(diagram.hiddenCount).toBe(1);
  });

  it("groups the shown files of a folder once two of them are shown", () => {
    const diagram = buildDiagram(graph, [], changed, stats, new Set());
    expect(diagram.groups).toEqual([
      { id: "folder:src", directory: "src", shortDirectory: { alias: null, rest: "src" }, nodePaths: ["src/a.ts", "src/new.ts", "src/lonely.ts"] },
      { id: "folder:src/lib", directory: "src/lib", shortDirectory: { alias: null, rest: "src/lib" }, nodePaths: ["src/lib/b.ts", "src/lib/c.ts"] },
    ]);
    expect(diagram.nodes.find((node) => node.path === "src/lib/b.ts")!.groupId).toBe("folder:src/lib");
    const alone = buildDiagram(graph, [], changed, stats, new Set(["src/new.ts"]));
    expect(alone.groups.map((group) => group.id)).toEqual(["folder:src", "folder:src/lib"]);
    expect(buildDiagram({ nodes: [], edges: [] }, [], [changed[0]], stats, new Set()).groups).toEqual([]);
  });

  it("abbreviates the directories of files under a shared prefix and lists the prefix in the legend", () => {
    const monorepo: ChangedFile[] = [
      { path: "apps/backend/src/app/user/user.seeder.ts", status: "M" },
      { path: "apps/backend/src/app/user/user.service.ts", status: "M" },
      { path: "apps/backend/src/common/db.ts", status: "M" },
      { path: "apps/web/src/pages/index.tsx", status: "M" },
      { path: "apps/web/src/pages/about.tsx", status: "M" },
      { path: "README.md", status: "M" },
    ];
    const diagram = buildDiagram({ nodes: [], edges: [] }, [], monorepo, [], new Set());
    expect(diagram.legend).toEqual([
      { alias: "backend", prefix: "apps/backend/src" },
      { alias: "web", prefix: "apps/web/src/pages" },
    ]);
    const byPath = new Map(diagram.nodes.map((node) => [node.path, node.shortDirectory]));
    // Grouped files leave the directory to their group label.
    expect(byPath.get("apps/backend/src/app/user/user.seeder.ts")).toBeNull();
    expect(byPath.get("apps/web/src/pages/index.tsx")).toBeNull();
    expect(byPath.get("apps/backend/src/common/db.ts")).toEqual({ alias: "backend", rest: "common" });
    expect(byPath.get("README.md")).toEqual({ alias: null, rest: "" });
    expect(diagram.groups.find((group) => group.id === "folder:apps/web/src/pages")!.shortDirectory).toEqual({ alias: "web", rest: "" });
  });

  it("works without a graph: changed files appear as unconnected nodes", () => {
    const diagram = buildDiagram({ nodes: [], edges: [] }, [], changed, [], new Set());
    expect(diagram.nodes).toHaveLength(2);
    expect(diagram.nodes.every((node) => node.width === MIN_NODE_WIDTH)).toBe(true);
    expect(diagram.edges).toEqual([]);
  });
});

describe("buildLegend", () => {
  it("skips generic names and prefixes too short to be worth an alias", () => {
    expect(buildLegend(["src/graph", "src/graph", "src/ide", "src/ide", "src", ""])).toEqual([]);
    expect(buildLegend(["src/graph/sub/deep", "src/graph/sub/deep"])).toEqual([{ alias: "graph", prefix: "src/graph/sub/deep" }]);
    // `frontend` would hide only `/src`, which is not worth a legend entry.
    expect(buildLegend(["backend/src/app", "backend/src/app", "frontend/src", "frontend/src/x"])).toEqual([{ alias: "backend", prefix: "backend/src/app" }]);
  });

  it("needs two files under a prefix and uses an alias only once", () => {
    expect(buildLegend(["apps/backend/src", "apps/web/src"])).toEqual([]);
    expect(buildLegend(["apps/backend/src", "apps/backend/src", "packages/backend/lib", "packages/backend/lib"])).toEqual([{ alias: "backend", prefix: "apps/backend/src" }]);
  });
});

describe("shortenDirectory", () => {
  it("replaces the prefix of a directory at or below it and leaves other directories alone", () => {
    const legend = [{ alias: "backend", prefix: "apps/backend/src" }];
    expect(shortenDirectory("apps/backend/src", legend)).toEqual({ alias: "backend", rest: "" });
    expect(shortenDirectory("apps/backend/src/app", legend)).toEqual({ alias: "backend", rest: "app" });
    expect(shortenDirectory("apps/backend/srcs", legend)).toEqual({ alias: null, rest: "apps/backend/srcs" });
    expect(shortenDirectory("", legend)).toEqual({ alias: null, rest: "" });
  });
});

describe("litByHover", () => {
  it("lights the hovered file, the edges leaving it and their targets, nothing when no file is hovered", () => {
    const diagram = buildDiagram(graph, [], changed, stats, new Set());
    const lit = litByHover(diagram, "src/a.ts");
    expect([...lit.nodePaths]).toEqual(["src/a.ts", "src/lib/b.ts"]);
    expect([...lit.edgeIds]).toEqual(["src/a.ts->src/lib/b.ts"]);
    expect(litByHover(diagram, null)).toEqual({ nodePaths: new Set(), edgeIds: new Set() });
  });
});
