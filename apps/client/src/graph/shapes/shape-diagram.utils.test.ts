import { describe, expect, it, vi } from "vitest";
import type { ShapeDiagram } from "./shape-diagram.types";
import { columnPortId, decorateShapeFlow, erdMarkers, layoutShapeDiagram, shapeNodeSize, TABLE_HEADER_HEIGHT, TABLE_HEADER_HEIGHT_WITH_DESCRIPTION, TABLE_ROW_HEIGHT, tableRowCenterY, toLayoutInput } from "./shape-diagram.utils";

// Node has no Web Worker; ELK's in-thread stand-in runs the layouts instead.
const elkWorker = (await import("elkjs/lib/elk-worker.js")) as unknown as { Worker: typeof Worker };
vi.stubGlobal("Worker", elkWorker.Worker);

const container: ShapeDiagram = {
  type: "c4-container",
  groups: [{ id: "shop", label: "Shop" }],
  nodes: [
    { id: "customer", kind: "person", label: "Customer" },
    { id: "web", kind: "container", label: "Web app", description: "React", parent: "shop" },
    { id: "api", kind: "container", label: "API", description: "Node, Express", parent: "shop" },
    { id: "db", kind: "database", label: "Orders DB", parent: "shop" },
    { id: "payments", kind: "externalSystem", label: "Payment provider" },
  ],
  edges: [
    { source: "customer", target: "web", label: "uses" },
    { source: "web", target: "api", label: "calls" },
    { source: "api", target: "db", label: "reads orders" },
    { source: "api", target: "payments", label: "charges" },
  ],
};

const states: ShapeDiagram = {
  type: "states",
  nodes: [{ id: "start", kind: "start", label: "Start" }, { id: "open", kind: "state", label: "Open" }, { id: "end", kind: "end", label: "End" }],
  edges: [{ source: "start", target: "open", label: "created" }, { source: "open", target: "end", label: "closed" }],
};

const erd: ShapeDiagram = {
  type: "erd",
  nodes: [
    { id: "orders", kind: "table", label: "orders", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }, { name: "customer_id", type: "uuid", isForeignKey: true }] },
    { id: "customers", kind: "table", label: "customers", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }, { name: "email", type: "text" }, { name: "created_at", type: "timestamptz" }] },
  ],
  edges: [{ source: "orders", target: "customers", sourceColumn: "customer_id", targetColumn: "id", cardinality: { source: "many", target: "one" }, label: "belongs to" }],
};

describe("shapeNodeSize", () => {
  it("sizes boxes from their label and tables from their columns, deterministically", () => {
    expect(shapeNodeSize({ id: "a", kind: "system", label: "Shop" })).toEqual({ width: 180, height: 64 });
    expect(shapeNodeSize({ id: "a", kind: "container", label: "API", description: "Node" })).toEqual({ width: 180, height: 80 });
    expect(shapeNodeSize({ id: "a", kind: "action", label: "Ship", actor: "Warehouse" }).height).toBe(80);
    expect(shapeNodeSize({ id: "a", kind: "system", label: "A".repeat(60) }).width).toBe(260);
    expect(shapeNodeSize({ id: "a", kind: "state", label: "A".repeat(25) }).width).toBe(25 * 7.4 + 32);
    expect(shapeNodeSize({ id: "a", kind: "person", label: "User" })).toEqual({ width: 120, height: 110 });
    expect(shapeNodeSize({ id: "a", kind: "database", label: "DB" })).toEqual({ width: 160, height: 84 });
    expect(shapeNodeSize({ id: "a", kind: "queue", label: "Q" })).toEqual({ width: 180, height: 64 });
    expect(shapeNodeSize({ id: "a", kind: "start", label: "Start" })).toEqual({ width: 28, height: 28 });
    expect(shapeNodeSize({ id: "a", kind: "decision", label: "Ok?" })).toEqual({ width: 170, height: 90 });
    const table = erd.nodes[1];
    expect(shapeNodeSize(table)).toEqual({ width: 220, height: TABLE_HEADER_HEIGHT + 3 * TABLE_ROW_HEIGHT + 6 });
    const wide = { ...table, columns: [{ name: "guideline_content_source_id", type: "timestamptz(6)" }] };
    expect(shapeNodeSize(wide).width).toBe(Math.round("guideline_content_source_id".length * 7 + "timestamptz(6)".length * 7.2 + 68));
    expect(shapeNodeSize(table)).toEqual(shapeNodeSize({ ...table }));
    expect(shapeNodeSize({ id: "a", kind: "table", label: "t", columns: [{ name: "id", type: "int" }] }).width).toBe(220);
    expect(shapeNodeSize({ id: "a", kind: "table", label: "a".repeat(80), columns: [{ name: "id", type: "int" }] }).width).toBe(360);
    expect(shapeNodeSize({ ...table, label: "customer_addresses_history", change: "changed" }).width).toBe(Math.round("customer_addresses_history".length * 7.8 + 72 + 68));
    const described = { ...table, description: "People who buy" };
    expect(shapeNodeSize(described).height).toBe(TABLE_HEADER_HEIGHT_WITH_DESCRIPTION + 3 * TABLE_ROW_HEIGHT + 6);
    expect(tableRowCenterY(table, 2)).toBe(TABLE_HEADER_HEIGHT + 2 * TABLE_ROW_HEIGHT + TABLE_ROW_HEIGHT / 2);
    expect(tableRowCenterY(described, 0)).toBe(TABLE_HEADER_HEIGHT_WITH_DESCRIPTION + TABLE_ROW_HEIGHT / 2);
  });
});

describe("toLayoutInput", () => {
  it("lays an erd out to the right with a port per column and edges between the column ports", () => {
    const input = toLayoutInput(erd);
    expect(input.direction).toBe("RIGHT");
    expect(input.mergeEdges).toBe(false);
    const orders = input.nodes[0];
    expect(orders.ports).toEqual([
      { id: "orders:id:out", x: orders.width, y: tableRowCenterY(erd.nodes[0], 0) },
      { id: "orders:id:in", x: 0, y: tableRowCenterY(erd.nodes[0], 0) },
      { id: "orders:customer_id:out", x: orders.width, y: tableRowCenterY(erd.nodes[0], 1) },
      { id: "orders:customer_id:in", x: 0, y: tableRowCenterY(erd.nodes[0], 1) },
    ]);
    expect(input.edges).toEqual([{ id: "orders.customer_id->customers.id", source: columnPortId("orders", "customer_id", "out"), target: columnPortId("customers", "id", "in"), label: undefined }]);
    expect(input.spacing).toEqual({ nodeNode: 48, betweenLayers: 120 });
    expect(input.maxNodesPerLayer).toBe(3);
    expect(toLayoutInput(container).maxNodesPerLayer).toBeUndefined();
  });

  it("lays every other type out top-down with merged edges and the groups as compound nodes", () => {
    const input = toLayoutInput(container);
    expect(input.direction).toBe("DOWN");
    expect(input.mergeEdges).toBe(true);
    expect(input.groups).toEqual([{ id: "shop" }]);
    expect(input.nodes[1]).toEqual({ id: "web", width: 180, height: 80, groupId: "shop" });
    expect(input.edges[0]).toEqual({ id: "customer->web", source: "customer", target: "web", label: "uses" });
  });
});

describe("layoutShapeDiagram", () => {
  it("places the containers of a boundary inside its box and lists the boundary first", async () => {
    const { nodes, edges } = await layoutShapeDiagram(container);
    const boundary = nodes[0];
    expect(boundary).toMatchObject({ id: "shop", type: "boundary", zIndex: -1, selectable: false, draggable: false, style: { pointerEvents: "none" } });
    const box = boundary.style as { width: number; height: number };
    for (const id of ["web", "api", "db"]) {
      const node = nodes.find((candidate) => candidate.id === id)!;
      expect(node.parentId).toBe("shop");
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
      expect(node.position.x + node.width!).toBeLessThanOrEqual(box.width);
      expect(node.position.y + node.height!).toBeLessThanOrEqual(box.height);
    }
    expect(nodes.find((node) => node.id === "customer")).toMatchObject({ type: "person", parentId: undefined, draggable: false, data: { width: 120, height: 110 } });
    expect(edges).toHaveLength(4);
    expect(edges[0]).toMatchObject({ id: "customer->web", type: "shape", source: "customer", target: "web", zIndex: -2, data: { label: "uses" } });
    expect(edges[0].markerEnd).toMatchObject({ type: "arrowclosed" });
    expect(edges[0].data!.points.length).toBeGreaterThanOrEqual(2);
    expect(edges[0].data!.labelCenter).not.toBeNull();
  });

  it("stacks a state diagram from its start node down to its end node", async () => {
    const { nodes } = await layoutShapeDiagram(states);
    const at = (id: string) => nodes.find((node) => node.id === id)!.position;
    expect(at("start").y).toBeLessThan(at("open").y);
    expect(at("open").y).toBeLessThan(at("end").y);
  });

  it("routes an erd relationship from the row of the foreign key to the row of the referenced key", async () => {
    const { nodes, edges } = await layoutShapeDiagram(erd);
    const orders = nodes.find((node) => node.id === "orders")!;
    const customers = nodes.find((node) => node.id === "customers")!;
    expect(orders.position.x + orders.width!).toBeLessThan(customers.position.x);
    const edge = edges[0];
    expect(edge).toMatchObject({ sourceHandle: "orders:customer_id:out", targetHandle: "customers:id:in", markerStart: "crow-many-rest", markerEnd: "crow-one-rest" });
    expect(edge.data).toMatchObject({ sourceColumn: "customer_id", targetColumn: "id", labelCenter: null, label: "belongs to" });
    const { points } = edge.data!;
    expect(points[0].x).toBeCloseTo(orders.position.x + orders.width!, 0);
    expect(Math.abs(points[0].y - (orders.position.y + tableRowCenterY(erd.nodes[0], 1)))).toBeLessThanOrEqual(1);
    const last = points[points.length - 1];
    expect(last.x).toBeCloseTo(customers.position.x, 0);
    expect(Math.abs(last.y - (customers.position.y + tableRowCenterY(erd.nodes[1], 0)))).toBeLessThanOrEqual(1);
  });

  it("returns an empty layout for an empty diagram", async () => {
    const { nodes, edges } = await layoutShapeDiagram({ type: "process", nodes: [], edges: [] });
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});

describe("erdMarkers", () => {
  it("picks the marker per cardinality and tone, the change color winning over the highlight", () => {
    expect(erdMarkers({ cardinality: { source: "many", target: "one" } }, false)).toEqual({ markerStart: "crow-many-rest", markerEnd: "crow-one-rest" });
    expect(erdMarkers({ cardinality: { source: "many", target: "one" } }, true)).toEqual({ markerStart: "crow-many-lit", markerEnd: "crow-one-lit" });
    expect(erdMarkers({ cardinality: { source: "one", target: "one" }, change: "added" }, true)).toEqual({ markerStart: "crow-one-added", markerEnd: "crow-one-added" });
    expect(erdMarkers({}, false)).toEqual({ markerStart: "crow-one-rest", markerEnd: "crow-one-rest" });
  });
});

describe("decorateShapeFlow", () => {
  const noFocus = { hoveredEdgeId: null, hoveredNodeId: null, selectedNodeId: null };

  it("lights the edges and columns of the hovered table and fades the rest", async () => {
    const third: ShapeDiagram = { ...erd, nodes: [...erd.nodes, { id: "products", kind: "table", label: "products", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }] }] };
    const flow = await layoutShapeDiagram(third);
    const { nodes, edges } = decorateShapeFlow(flow.nodes, flow.edges, { ...noFocus, hoveredNodeId: "orders" }, true);
    const byId = (id: string) => nodes.find((node) => node.id === id)!;
    expect(byId("orders").data).toMatchObject({ isHovered: true, isMuted: false, litColumns: ["customer_id"] });
    expect(byId("customers").data).toMatchObject({ isHovered: false, isMuted: false, litColumns: ["id"] });
    expect(byId("products").data).toMatchObject({ isMuted: true });
    expect(byId("products").data.litColumns).toBeUndefined();
    expect(edges[0]).toMatchObject({ selected: true, markerStart: "crow-many-lit", markerEnd: "crow-one-lit", data: { isLit: true, isHovered: false, isMuted: false } });
  });

  it("marks the hovered edge and the selected table, mutes other edges but no node", async () => {
    const flow = await layoutShapeDiagram(erd);
    const { nodes, edges } = decorateShapeFlow(flow.nodes, flow.edges, { hoveredEdgeId: "nope", hoveredNodeId: null, selectedNodeId: "customers" }, true);
    expect(nodes.find((node) => node.id === "customers")!.data).toMatchObject({ isSelected: true, isMuted: false });
    expect(edges[0]).toMatchObject({ selected: false, markerStart: "crow-many-rest", data: { isLit: false, isMuted: true } });
    const hovered = decorateShapeFlow(flow.nodes, flow.edges, { ...noFocus, hoveredEdgeId: edges[0].id }, true);
    expect(hovered.edges[0].data).toMatchObject({ isHovered: true, isLit: true, isMuted: false });
    expect(hovered.nodes.every((node) => !node.data.isMuted)).toBe(true);
  });

  it("uses arrowheads for the other diagram types and leaves boundaries alone", async () => {
    const flow = await layoutShapeDiagram(container);
    const { nodes, edges } = decorateShapeFlow(flow.nodes, flow.edges, { ...noFocus, hoveredNodeId: "api" }, false);
    expect(nodes.find((node) => node.id === "shop")).toBe(flow.nodes.find((node) => node.id === "shop"));
    const toDb = edges.find((edge) => edge.id === "api->db")!;
    expect(toDb.markerEnd).toMatchObject({ color: "#e5e7eb" });
    expect(edges.find((edge) => edge.id === "customer->web")!).toMatchObject({ markerEnd: { color: "#4b5563" }, data: { isMuted: true } });
  });
});
