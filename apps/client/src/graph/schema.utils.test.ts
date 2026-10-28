import { describe, expect, it } from "vitest";
import { isSymbolLikeLabel, isThirdPartyPath, isWorktreePath, parseGraph, parseReviewLevel } from "./schema.utils";

const valid = {
  nodes: [
    { path: "src/state/store.ts", review: 4, reviewReason: "Central store every view reads." },
    { path: "src/app/App.tsx", review: 2 },
  ],
  edges: [{ source: "src/app/App.tsx", target: "src/state/store.ts", label: "session state", description: "Reads the session list and the active session from the store." }],
};

describe("isWorktreePath", () => {
  it("accepts relative paths and rejects absolute or escaping ones", () => {
    expect(isWorktreePath("src/a.ts")).toBe(true);
    expect(isWorktreePath("/src/a.ts")).toBe(false);
    expect(isWorktreePath("src/../a.ts")).toBe(false);
    expect(isWorktreePath("")).toBe(false);
    expect(isWorktreePath(42)).toBe(false);
  });
});

describe("isThirdPartyPath", () => {
  it("is true only for paths with a node_modules segment", () => {
    expect(isThirdPartyPath("node_modules/@nestjs/common/index.d.ts")).toBe(true);
    expect(isThirdPartyPath("backend/node_modules/lodash/index.js")).toBe(true);
    expect(isThirdPartyPath("src/node_modules_shim.ts")).toBe(false);
  });
});

describe("parseReviewLevel", () => {
  it("accepts the integers 1 to 4, also as numeric strings, and nothing else", () => {
    expect(parseReviewLevel(1)).toBe(1);
    expect(parseReviewLevel("4")).toBe(4);
    expect(parseReviewLevel(0)).toBeUndefined();
    expect(parseReviewLevel(5)).toBeUndefined();
    expect(parseReviewLevel(2.5)).toBeUndefined();
    expect(parseReviewLevel("high")).toBeUndefined();
    expect(parseReviewLevel(undefined)).toBeUndefined();
  });
});

describe("parseGraph", () => {
  it("accepts a schema-conforming graph without problems", () => {
    const parsed = parseGraph(valid);
    expect(parsed.problems).toEqual([]);
    expect(parsed.graph.nodes).toEqual([
      { path: "src/state/store.ts", review: 4, reviewReason: "Central store every view reads." },
      { path: "src/app/App.tsx", review: 2 },
    ]);
    expect(parsed.graph.edges).toEqual(valid.edges);
  });

  it("rejects anything that is not an object with nodes and edges", () => {
    expect(parseGraph(null).problems).toHaveLength(1);
    expect(parseGraph({ nodes: [] }).graph.nodes).toEqual([]);
  });

  it("drops nodes without a valid path and duplicate paths", () => {
    const parsed = parseGraph({
      nodes: [{ path: "a.ts", review: 1 }, { path: "a.ts", review: 1 }, { path: "/etc/passwd" }, { label: "no path" }, "not an object"],
      edges: [],
    });
    expect(parsed.graph.nodes.map((node) => node.path)).toEqual(["a.ts"]);
    expect(parsed.problems).toHaveLength(4);
  });

  it("accepts a node without a rating as a context file and reports an invalid rating, keeping the node without one", () => {
    const parsed = parseGraph({
      nodes: [{ path: "a.ts" }, { path: "b.ts", review: 7, reviewReason: "Ignored without a valid level." }, { path: "c.ts", review: "3", reviewReason: "Shared helper." }],
      edges: [],
    });
    expect(parsed.graph.nodes).toEqual([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts", review: 3, reviewReason: "Shared helper." }]);
    expect(parsed.problems.filter((problem) => problem.includes("review rating"))).toEqual(['Node "b.ts" has a review rating that is not an integer from 1 to 4 (7).']);
  });

  it("drops nodes and edges inside node_modules", () => {
    const parsed = parseGraph({
      nodes: [{ path: "src/app.ts", review: 2 }, { path: "node_modules/@nestjs/common/index.d.ts", review: 1 }],
      edges: [
        { source: "src/app.ts", target: "node_modules/@nestjs/common/index.d.ts", label: "HTTP decorators" },
        { source: "backend/node_modules/x/index.js", target: "src/app.ts", label: "nonsense" },
      ],
    });
    expect(parsed.graph.nodes.map((node) => node.path)).toEqual(["src/app.ts"]);
    expect(parsed.graph.edges).toEqual([]);
    expect(parsed.problems).toHaveLength(3);
  });

  it("adds unlisted edge endpoints as nodes, repairs missing labels and drops self and duplicate edges", () => {
    const parsed = parseGraph({
      nodes: [{ path: "a.ts", review: 1 }],
      edges: [
        { source: "a.ts", target: "b.ts" },
        { source: "a.ts", target: "b.ts", label: "again" },
        { source: "a.ts", target: "a.ts", label: "loops" },
        { source: "a.ts", label: "no target" },
      ],
    });
    expect(parsed.graph.nodes.map((node) => node.path)).toEqual(["a.ts", "b.ts"]);
    expect(parsed.graph.edges).toEqual([{ source: "a.ts", target: "b.ts" }]);
    expect(parsed.problems).toHaveLength(5);
  });

  it("drops a label that names a symbol or file", () => {
    const parsed = parseGraph({
      nodes: [],
      edges: [
        { source: "a.ts", target: "user/user.service.ts", label: "UserService", description: "Calls it." },
        { source: "a.ts", target: "lib/layout.ts", label: "layout" },
        { source: "a.ts", target: "lib/other.ts", label: "Antwortformat" },
      ],
    });
    expect(parsed.graph.edges.map((edge) => edge.label)).toEqual([undefined, undefined, "Antwortformat"]);
    expect(parsed.graph.edges[0].description).toBe("Calls it.");
    expect(parsed.problems.filter((problem) => problem.includes("instead of a purpose"))).toHaveLength(2);
  });
});

describe("isSymbolLikeLabel", () => {
  it("flags identifiers and file names, not purposes", () => {
    expect(isSymbolLikeLabel("PaginatedResult", "a.ts", "b.ts")).toBe(true);
    expect(isSymbolLikeLabel("useUsers", "a.ts", "b.ts")).toBe(true);
    expect(isSymbolLikeLabel("MAX_PAGE_SIZE", "a.ts", "b.ts")).toBe(true);
    expect(isSymbolLikeLabel("user.service.ts", "a.ts", "b.ts")).toBe(true);
    expect(isSymbolLikeLabel("user.service", "a.ts", "user/user.service.ts")).toBe(true);
    expect(isSymbolLikeLabel("UserService", "a.ts", "user/user.service.ts")).toBe(true);
    expect(isSymbolLikeLabel("Antwortformat", "a.ts", "b.ts")).toBe(false);
    expect(isSymbolLikeLabel("ORM-Lebenszyklus", "a.ts", "b.ts")).toBe(false);
    expect(isSymbolLikeLabel("Paginierung erben", "a.ts", "b.ts")).toBe(false);
    expect(isSymbolLikeLabel("GraphQL", "a.ts", "b.ts")).toBe(false);
  });
});
