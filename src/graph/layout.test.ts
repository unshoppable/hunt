import { describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "../ipc/types";
import { buildDiagram } from "./diagram";
import { LABEL_HEIGHT, labelWidth, layoutDiagram, orthogonalPath } from "./layout";

const graph: ArchitectureGraph = {
  nodes: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
  edges: [
    { source: "a.ts", target: "b.ts", label: "calls" },
    { source: "a.ts", target: "c.ts", label: "imports" },
    { source: "b.ts", target: "c.ts", label: "imports" },
  ],
};
const changed = [{ path: "a.ts", status: "M" }];
const stats = [{ path: "a.ts", added: 40, removed: 2 }];

const grouped: ArchitectureGraph = {
  nodes: [{ path: "src/app/a.ts" }, { path: "src/app/b.ts" }, { path: "src/lib/c.ts" }, { path: "src/lib/d.ts" }, { path: "top.ts" }],
  edges: [
    { source: "src/app/a.ts", target: "src/lib/c.ts", label: "uses c" },
    { source: "src/app/b.ts", target: "src/app/a.ts", label: "extends a" },
    { source: "src/lib/c.ts", target: "src/lib/d.ts", label: "uses d" },
    { source: "top.ts", target: "src/app/a.ts", label: "boots" },
  ],
};
const groupedChanged = [{ path: "src/app/a.ts", status: "M" }];

describe("orthogonalPath", () => {
  it("draws straight segments with rounded corners at the bends", () => {
    expect(orthogonalPath([{ x: 0, y: 0 }, { x: 0, y: 40 }])).toBe("M 0 0 L 0 40");
    expect(orthogonalPath([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 30, y: 40 }])).toBe("M 0 0 L 0 32 Q 0 40 8 40 L 30 40");
    expect(orthogonalPath([{ x: 0, y: 0 }])).toBe("");
  });
});

describe("layoutDiagram", () => {
  it("positions dependents above their dependencies without overlaps and keeps the node sizes", async () => {
    const { nodes, edges } = await layoutDiagram(buildDiagram(graph, [], changed, stats, new Set()));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const at = (id: string) => byId.get(id)!.position;
    expect(at("a.ts").y).toBeLessThan(at("b.ts").y);
    expect(at("b.ts").y).toBeLessThan(at("c.ts").y);
    expect(byId.get("a.ts")!.width).toBeGreaterThan(byId.get("b.ts")!.width!);
    // The three root files share one group; their positions are relative to it and must not overlap.
    const files = nodes.filter((node) => node.type === "file");
    expect(files.every((node) => node.parentId === "folder:")).toBe(true);
    for (const first of files) {
      for (const second of files) {
        if (first === second) continue;
        const overlapsX = first.position.x < second.position.x + second.width! && second.position.x < first.position.x + first.width!;
        const overlapsY = first.position.y < second.position.y + second.height! && second.position.y < first.position.y + first.height!;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }
    expect(edges).toHaveLength(3);
    expect(edges[0]).toMatchObject({ type: "dependency", data: { label: "calls" } });
    for (const edge of edges) {
      expect(edge.data!.points.length).toBeGreaterThanOrEqual(2);
      expect(edge.data!.labelCenter).not.toBeNull();
    }
  });

  it("nests files in their folder group and routes edges between groups in absolute coordinates", async () => {
    const { nodes, edges } = await layoutDiagram(buildDiagram(grouped, [], groupedChanged, [], new Set()));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(nodes.slice(0, 2).map((node) => node.type)).toEqual(["folder", "folder"]);
    const app = byId.get("folder:src/app")!;
    const a = byId.get("src/app/a.ts")!;
    expect(a.parentId).toBe("folder:src/app");
    expect(byId.get("top.ts")!.parentId).toBeUndefined();
    expect(app.width!).toBeGreaterThan(a.width!);
    expect(app.height!).toBeGreaterThan(a.height!);
    // A route from a.ts (inside src/app) to c.ts (inside src/lib) starts at a.ts's bottom border in flow coordinates.
    const absoluteA = { x: app.position.x + a.position.x, y: app.position.y + a.position.y };
    const route = edges.find((edge) => edge.id === "src/app/a.ts->src/lib/c.ts")!.data!.points;
    expect(route[0].y).toBeCloseTo(absoluteA.y + a.height!, 0);
    expect(route[0].x).toBeGreaterThan(absoluteA.x);
    expect(route[0].x).toBeLessThan(absoluteA.x + a.width!);
    const lib = byId.get("folder:src/lib")!;
    const c = byId.get("src/lib/c.ts")!;
    const last = route[route.length - 1];
    expect(last.y).toBeCloseTo(lib.position.y + c.position.y, 0);
  });

  it("puts every label on a segment of its edge that is long enough for it and clear of the files", async () => {
    const { nodes, edges } = await layoutDiagram(buildDiagram(grouped, [], groupedChanged, [], new Set()));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const fileBoxes = nodes
      .filter((node) => node.type === "file")
      .map((node) => {
        const parent = node.parentId ? byId.get(node.parentId)! : null;
        const x = node.position.x + (parent?.position.x ?? 0);
        const y = node.position.y + (parent?.position.y ?? 0);
        return { left: x, right: x + node.width!, top: y, bottom: y + node.height! };
      });
    for (const edge of edges) {
      const { points, label, labelCenter } = edge.data!;
      const box = { left: labelCenter!.x - labelWidth(label) / 2, right: labelCenter!.x + labelWidth(label) / 2, top: labelCenter!.y - LABEL_HEIGHT / 2, bottom: labelCenter!.y + LABEL_HEIGHT / 2 };
      const carrier = points.slice(1).find((to, index) => {
        const from = points[index];
        const isHorizontalCarrier = Math.abs(from.y - to.y) < 0.5 && Math.abs(from.y - labelCenter!.y) <= 1 && Math.min(from.x, to.x) <= box.left + 0.5 && Math.max(from.x, to.x) >= box.right - 0.5;
        const isVerticalCarrier = Math.abs(from.x - to.x) < 0.5 && Math.abs(from.x - labelCenter!.x) <= 1 && Math.min(from.y, to.y) <= box.top + 0.5 && Math.max(from.y, to.y) >= box.bottom - 0.5;
        return isHorizontalCarrier || isVerticalCarrier;
      });
      expect(carrier, `${edge.id} label off its edge`).toBeDefined();
      for (const file of fileBoxes) {
        const overlaps = box.left < file.right && file.left < box.right && box.top < file.bottom && file.top < box.bottom;
        expect(overlaps, `${edge.id} label under a file`).toBe(false);
      }
    }
  });

  it("returns an empty layout for an empty diagram", async () => {
    const { nodes, edges } = await layoutDiagram({ nodes: [], groups: [], edges: [], legend: [], hiddenCount: 0 });
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});
