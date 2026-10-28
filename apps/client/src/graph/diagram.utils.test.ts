import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../common/changes/changed-file.types";
import type { ChangeStat } from "../diff/diff.types";
import type { ArchitectureGraph } from "./graph.types";
import { MAX_NODE_HEIGHT, MAX_NODE_WIDTH, MIN_NODE_HEIGHT, MIN_NODE_WIDTH, buildDiagram, labelDirectories, litByHover, mergeEdges, nodeSize } from "./diagram.utils";

const graph: ArchitectureGraph = {
  nodes: [{ path: "src/a.ts", review: 4, reviewReason: "Public entry point." }, { path: "src/lib/b.ts" }, { path: "src/lib/c.ts" }, { path: "src/lonely.ts" }],
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
    expect(byPath.get("src/a.ts")).toMatchObject({ isChanged: true, status: "M", added: 30, removed: 10, width: MAX_NODE_WIDTH, name: "a.ts", directory: "src", shortDirectory: { alias: null, rest: "src", full: "src" } });
    expect(byPath.get("src/new.ts")!.width).toBeLessThan(MAX_NODE_WIDTH);
    expect(byPath.get("src/new.ts")!.width).toBeGreaterThan(MIN_NODE_WIDTH);
    expect(byPath.get("src/lib/b.ts")).toMatchObject({ isChanged: false, added: 0, removed: 0, width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT });
  });

  it("widens a box to the width its content needs", () => {
    const diagram = buildDiagram(graph, [], changed, stats, new Set(), undefined, (node) => (node.path === "src/new.ts" ? 412.3 : 0));
    const byPath = new Map(diagram.nodes.map((node) => [node.path, node]));
    expect(byPath.get("src/new.ts")!.width).toBe(413);
    expect(byPath.get("src/a.ts")!.width).toBe(MAX_NODE_WIDTH);
    expect(byPath.get("src/lib/b.ts")!.width).toBe(MIN_NODE_WIDTH);
  });

  it("hides excluded changed files together with the context that only they reach", () => {
    const diagram = buildDiagram(graph, [], changed, stats, new Set(["src/a.ts"]));
    expect(diagram.nodes.map((node) => node.path)).toEqual(["src/new.ts"]);
    expect(diagram.edges).toEqual([]);
    expect(diagram.hiddenCount).toBe(1);
  });

  it("hides files rated below the minimum, keeps unrated ones and lets hidden files block the way to context", () => {
    const rated: ArchitectureGraph = { ...graph, nodes: [{ path: "src/a.ts", review: 2 }, { path: "src/lib/b.ts", review: 4 }, { path: "src/lib/c.ts" }, { path: "src/lonely.ts", review: 1 }] };
    const atTwo = buildDiagram(rated, [], changed, stats, new Set(), { minReview: 2, hiddenGlobs: [] });
    expect(atTwo.nodes.map((node) => node.path)).toEqual(["src/a.ts", "src/new.ts", "src/lib/b.ts", "src/lib/c.ts"]);
    expect(atTwo.edges.map((edge) => edge.id)).toEqual(["src/a.ts->src/lib/b.ts", "src/lib/b.ts->src/lib/c.ts"]);
    const atThree = buildDiagram(rated, [], changed, stats, new Set(), { minReview: 3, hiddenGlobs: [] });
    expect(atThree.nodes.map((node) => node.path)).toEqual(["src/new.ts"]);
    expect(atThree.hiddenCount).toBe(1);
  });

  it("hides changed and context files matching a glob", () => {
    const withoutLib = buildDiagram(graph, [], changed, stats, new Set(), { minReview: 1, hiddenGlobs: ["src/lib/**"] });
    expect(withoutLib.nodes.map((node) => node.path)).toEqual(["src/a.ts", "src/new.ts"]);
    expect(withoutLib.hiddenCount).toBe(0);
    const withoutNew = buildDiagram(graph, [], changed, stats, new Set(["src/a.ts"]), { minReview: 1, hiddenGlobs: ["*.spec.ts", "new.ts"] });
    expect(withoutNew.nodes).toEqual([]);
    expect(withoutNew.hiddenCount).toBe(2);
  });

  it("groups the shown files of a folder once two of them are shown", () => {
    const diagram = buildDiagram(graph, [], changed, stats, new Set());
    expect(diagram.groups).toEqual([
      { id: "folder:src", directory: "src", shortDirectory: { alias: null, rest: "src", full: "src" }, nodePaths: ["src/a.ts", "src/new.ts", "src/lonely.ts"] },
      { id: "folder:src/lib", directory: "src/lib", shortDirectory: { alias: null, rest: "src/lib", full: "src/lib" }, nodePaths: ["src/lib/b.ts", "src/lib/c.ts"] },
    ]);
    expect(diagram.nodes.find((node) => node.path === "src/lib/b.ts")!.groupId).toBe("folder:src/lib");
    const alone = buildDiagram(graph, [], changed, stats, new Set(["src/new.ts"]));
    expect(alone.groups.map((group) => group.id)).toEqual(["folder:src", "folder:src/lib"]);
    expect(buildDiagram({ nodes: [], edges: [] }, [], [changed[0]], stats, new Set()).groups).toEqual([]);
  });

  it("labels directories by their module and lists the modules in the legend", () => {
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
      { alias: "backend", prefix: "apps/backend" },
      { alias: "web", prefix: "apps/web" },
    ]);
    const byPath = new Map(diagram.nodes.map((node) => [node.path, node.shortDirectory]));
    expect(byPath.get("apps/backend/src/app/user/user.seeder.ts")).toEqual({ alias: "backend", rest: "user", full: "user" });
    expect(byPath.get("apps/web/src/pages/index.tsx")).toEqual({ alias: "web", rest: "pages", full: "pages" });
    expect(byPath.get("apps/backend/src/common/db.ts")).toEqual({ alias: "backend", rest: "common", full: "common" });
    expect(byPath.get("README.md")).toEqual({ alias: null, rest: "", full: "" });
    expect(diagram.groups.find((group) => group.id === "folder:apps/web/src/pages")!.shortDirectory).toEqual({ alias: "web", rest: "pages", full: "pages" });
  });

  it("works without a graph: changed files appear as unconnected nodes", () => {
    const diagram = buildDiagram({ nodes: [], edges: [] }, [], changed, [], new Set());
    expect(diagram.nodes).toHaveLength(2);
    expect(diagram.nodes.every((node) => node.width === MIN_NODE_WIDTH)).toBe(true);
    expect(diagram.edges).toEqual([]);
  });
});

describe("labelDirectories", () => {
  const labelsOf = (directories: string[]) => {
    const { labelOf } = labelDirectories(directories);
    return Object.fromEntries(directories.map((directory) => [directory, labelOf(directory)]));
  };

  it("names a module by its folders before the source tree and keeps the first and last folders below it", () => {
    const api = "apps/ppp-rl/backend/src/app/api/workforce/employee/import";
    const directories = [api, `${api}/adapters/vivendi-pep`, `${api}/adapters/vivendi-pep/__tests__`, "libs/ppp-rl/angular/swagger/src/lib"];
    expect(labelDirectories(directories).legend).toEqual([
      { alias: "ppp-rl-backend", prefix: "apps/ppp-rl/backend" },
      { alias: "ppp-rl-angular-swagger", prefix: "libs/ppp-rl/angular/swagger" },
    ]);
    expect(labelsOf(directories)).toEqual({
      [api]: { alias: "ppp-rl-backend", rest: "api/…/import", full: "api/workforce/employee/import" },
      [`${api}/adapters/vivendi-pep`]: { alias: "ppp-rl-backend", rest: "api/…/vivendi-pep", full: "api/workforce/employee/import/adapters/vivendi-pep" },
      [`${api}/adapters/vivendi-pep/__tests__`]: { alias: "ppp-rl-backend", rest: "api/…/vivendi-pep/__tests__", full: "api/workforce/employee/import/adapters/vivendi-pep/__tests__" },
      "libs/ppp-rl/angular/swagger/src/lib": { alias: "ppp-rl-angular-swagger", rest: "", full: "" },
    });
  });

  it("shows short folder paths in full and takes more trailing folders until labels differ", () => {
    expect(labelsOf(["apps/x/src/a/b/c", "apps/x/src/a/b/c/d/e/dto", "apps/x/src/a/b/c/f/e/dto", "apps/x/src/a/b/g/e/dto"])).toEqual({
      "apps/x/src/a/b/c": { alias: "x", rest: "a/b/c", full: "a/b/c" },
      "apps/x/src/a/b/c/d/e/dto": { alias: "x", rest: "a/…/d/e/dto", full: "a/b/c/d/e/dto" },
      "apps/x/src/a/b/c/f/e/dto": { alias: "x", rest: "a/…/f/e/dto", full: "a/b/c/f/e/dto" },
      // Hiding only `b` is not worth an ellipsis.
      "apps/x/src/a/b/g/e/dto": { alias: "x", rest: "a/b/g/e/dto", full: "a/b/g/e/dto" },
    });
  });

  it("labels a directory below a module root without a source folder by that module", () => {
    expect(labelsOf(["apps/x/src/y", "apps/x/test/e2e", "apps/x"])).toEqual({
      "apps/x/src/y": { alias: "x", rest: "y", full: "y" },
      "apps/x/test/e2e": { alias: "x", rest: "test/e2e", full: "test/e2e" },
      "apps/x": { alias: "x", rest: "", full: "" },
    });
  });

  it("drops a leading source folder outside modules and keeps folders that are nothing but source folders", () => {
    const directories = ["src/graph", "src", "src/lib", "src-tauri/src/session", "docs/adr", ""];
    expect(labelDirectories(directories).legend).toEqual([]);
    expect(labelsOf(directories)).toEqual({
      "src/graph": { alias: null, rest: "graph", full: "graph" },
      src: { alias: null, rest: "src", full: "src" },
      "src/lib": { alias: null, rest: "src/lib", full: "src/lib" },
      "src-tauri/src/session": { alias: "src-tauri", rest: "session", full: "session" },
      "docs/adr": { alias: null, rest: "docs/adr", full: "docs/adr" },
      "": { alias: null, rest: "", full: "" },
    });
  });

  it("keeps the container folders of modules that would share a name", () => {
    expect(labelDirectories(["apps/foo/src/a", "libs/foo/src/b"]).legend).toEqual([
      { alias: "apps-foo", prefix: "apps/foo" },
      { alias: "libs-foo", prefix: "libs/foo" },
    ]);
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
