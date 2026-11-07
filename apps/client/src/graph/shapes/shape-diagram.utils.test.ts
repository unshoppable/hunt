import { describe, expect, it, vi } from "vitest";
import type { ShapeDiagram } from "./shape-diagram.types";
import { columnPortId, decorateShapeFlow, erdMarkers, isChangeDiagram, isContextConnection, layoutShapeDiagram, portColumn, relationshipEnds, relationshipSides, shapeNodeSize, TABLE_HEADER_HEIGHT, TABLE_HEADER_HEIGHT_WITH_DESCRIPTION, TABLE_ROW_HEIGHT, tableRowCenterY, toLayoutInput, withoutDeleted } from "./shape-diagram.utils";

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
    expect(shapeNodeSize({ ...table, label: "customer_addresses", change: "changed" }).width).toBe(Math.round("customer_addresses".length * 9 + 72 + 68));
    const described = { ...table, description: "People who buy" };
    expect(shapeNodeSize(described).height).toBe(TABLE_HEADER_HEIGHT_WITH_DESCRIPTION + 3 * TABLE_ROW_HEIGHT + 6);
    expect(tableRowCenterY(table, 2)).toBe(TABLE_HEADER_HEIGHT + 2 * TABLE_ROW_HEIGHT + TABLE_ROW_HEIGHT / 2);
    expect(tableRowCenterY(described, 0)).toBe(TABLE_HEADER_HEIGHT_WITH_DESCRIPTION + TABLE_ROW_HEIGHT / 2);
  });
});

describe("portColumn", () => {
  it("finds the column of any port of a table, also when ids and names hold a colon", () => {
    const [orders] = erd.nodes;
    for (const end of ["in", "out"] as const) {
      expect(portColumn(orders, columnPortId("orders", "customer_id", end, "left"))?.name).toBe("customer_id");
      expect(portColumn(orders, columnPortId("orders", "id", end, "right"))?.name).toBe("id");
    }
    const colons = { id: "a:b", columns: [{ name: "c:d", type: "int" }, { name: "d", type: "int" }] };
    expect(portColumn(colons, columnPortId("a:b", "c:d", "out", "left"))?.name).toBe("c:d");
    expect(portColumn(colons, columnPortId("a:b", "d", "in", "right"))?.name).toBe("d");
    expect(portColumn(orders, columnPortId("customers", "id", "in", "left"))).toBeUndefined();
    expect(portColumn(orders, null)).toBeUndefined();
  });
});

describe("relationshipSides", () => {
  it("takes the facing sides of tables beside each other and the same side of tables above each other", () => {
    const left = { x: 0, y: 0, width: 200, height: 100 };
    const right = { x: 400, y: 300, width: 200, height: 100 };
    expect(relationshipSides(left, right)).toEqual({ source: "right", target: "left" });
    expect(relationshipSides(right, left)).toEqual({ source: "left", target: "right" });
    expect(relationshipSides({ x: 0, y: 0, width: 200, height: 100 }, { x: 240, y: 300, width: 200, height: 100 })).toEqual({ source: "right", target: "right" });
    expect(relationshipSides({ x: 0, y: 0, width: 300, height: 100 }, { x: 20, y: 300, width: 100, height: 100 })).toEqual({ source: "left", target: "left" });
  });
});

describe("relationshipEnds", () => {
  it("puts the ends on the rows of the columns, on the sides the placement calls for", () => {
    const [orders, customers] = erd.nodes;
    const source = { box: { x: 0, y: 0, ...shapeNodeSize(orders) }, table: orders, column: "customer_id" };
    const target = { box: { x: 600, y: 40, ...shapeNodeSize(customers) }, table: customers, column: "id" };
    expect(relationshipEnds(source, target)).toEqual({
      source: { x: shapeNodeSize(orders).width, y: tableRowCenterY(orders, 1), side: "right" },
      target: { x: 600, y: 40 + tableRowCenterY(customers, 0), side: "left" },
    });
    expect(relationshipEnds({ ...source, column: "missing" }, target)).toBeNull();
  });
});

describe("toLayoutInput", () => {
  it("lays an erd out to the right, between the tables without sides and between the column ports on the sides given", () => {
    const plain = toLayoutInput(erd);
    expect(plain.direction).toBe("RIGHT");
    expect(plain.mergeEdges).toBe(false);
    expect(plain.nodes[0].ports).toBeUndefined();
    expect(plain.edges).toEqual([{ id: "orders.customer_id->customers.id", source: "orders", target: "customers", label: undefined }]);
    expect(plain.spacing).toEqual({ nodeNode: 48, betweenLayers: 120 });
    expect(plain.maxNodesPerLayer).toBe(3);
    expect(toLayoutInput(container).maxNodesPerLayer).toBeUndefined();

    const input = toLayoutInput(erd, new Map([["orders.customer_id->customers.id", { source: "left", target: "right" }]]));
    const [orders, customers] = input.nodes;
    expect(orders.ports).toEqual([{ id: "orders:customer_id:out:left", x: 0, y: tableRowCenterY(erd.nodes[0], 1) }]);
    expect(customers.ports).toEqual([{ id: "customers:id:in:right", x: customers.width, y: tableRowCenterY(erd.nodes[1], 0) }]);
    expect(input.edges).toEqual([
      { id: "orders.customer_id->customers.id", source: columnPortId("orders", "customer_id", "out", "left"), target: columnPortId("customers", "id", "in", "right"), label: undefined },
    ]);
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
    expect(nodes.find((node) => node.id === "customer")).toMatchObject({ type: "person", parentId: undefined, draggable: true, data: { width: 120, height: 110 } });
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
    expect(edge).toMatchObject({ sourceHandle: "orders:customer_id:out:right", targetHandle: "customers:id:in:left", markerStart: "crow-many-rest", markerEnd: "crow-one-rest" });
    expect(edge.data).toMatchObject({ sourceColumn: "customer_id", targetColumn: "id", labelCenter: null, label: "belongs to" });
    const { points } = edge.data!;
    expect(points[0].x).toBeCloseTo(orders.position.x + orders.width!, 0);
    expect(Math.abs(points[0].y - (orders.position.y + tableRowCenterY(erd.nodes[0], 1)))).toBeLessThanOrEqual(1);
    const last = points[points.length - 1];
    expect(last.x).toBeCloseTo(customers.position.x, 0);
    expect(Math.abs(last.y - (customers.position.y + tableRowCenterY(erd.nodes[1], 0)))).toBeLessThanOrEqual(1);
  });

  it("keeps placed elements where they are, fits the boundary around them and routes the connections itself", async () => {
    const placed: ShapeDiagram = {
      ...container,
      nodes: container.nodes.map((node) => (node.id === "web" ? { ...node, position: { x: 500, y: 400 } } : node.id === "api" ? { ...node, position: { x: 900, y: 400 } } : node)),
    };
    const { nodes, edges } = await layoutShapeDiagram(placed);
    const boundary = nodes.find((node) => node.id === "shop")!;
    const web = nodes.find((node) => node.id === "web")!;
    expect(web.parentId).toBe("shop");
    expect({ x: boundary.position.x + web.position.x, y: boundary.position.y + web.position.y }).toEqual({ x: 500, y: 400 });
    const api = nodes.find((node) => node.id === "api")!;
    expect(boundary.position.x + api.position.x).toBe(900);
    for (const id of ["web", "api", "db"]) {
      const node = nodes.find((candidate) => candidate.id === id)!;
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
      expect(node.position.x + node.width!).toBeLessThanOrEqual(boundary.width!);
      expect(node.position.y + node.height!).toBeLessThanOrEqual(boundary.height!);
    }
    expect(edges.every((edge) => edge.data!.points.length >= 2 && edge.data!.labelCenter === null && edge.data!.hasInlineLabel)).toBe(true);
    const webToApi = edges.find((edge) => edge.id === "web->api")!.data!.points;
    expect(webToApi[0]).toEqual({ x: 500 + web.width! / 2, y: 400 + web.height! });
    expect(webToApi[webToApi.length - 1]).toEqual({ x: 900 + api.width! / 2, y: 400 });
  });

  it("returns an empty layout for an empty diagram", async () => {
    const { nodes, edges } = await layoutShapeDiagram({ type: "process", nodes: [], edges: [] });
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});

describe("withoutDeleted", () => {
  it("drops a connection, an element with its connections, or a boundary leaving its elements where they are", async () => {
    const flow = await layoutShapeDiagram(container);
    expect(withoutDeleted(flow, { kind: "edge", id: "web->api" }).edges.map((edge) => edge.id)).toEqual(["customer->web", "api->db", "api->payments"]);
    const withoutApi = withoutDeleted(flow, { kind: "node", id: "api" });
    expect(withoutApi.nodes.map((node) => node.id)).toEqual(["shop", "customer", "web", "db", "payments"]);
    expect(withoutApi.edges.map((edge) => edge.id)).toEqual(["customer->web"]);
    const shop = flow.nodes.find((node) => node.id === "shop");
    const web = flow.nodes.find((node) => node.id === "web");
    const withoutShop = withoutDeleted(flow, { kind: "group", id: "shop" });
    expect(withoutShop.nodes.map((node) => node.id)).toEqual(["customer", "web", "api", "db", "payments"]);
    expect(withoutShop.nodes.find((node) => node.id === "web")).toMatchObject({ parentId: undefined, position: { x: shop!.position.x + web!.position.x, y: shop!.position.y + web!.position.y } });
    expect(withoutShop.edges).toBe(flow.edges);
  });
});

describe("isContextConnection", () => {
  const changed: ShapeDiagram = {
    type: "c4-container",
    nodes: [
      { id: "web", kind: "container", label: "Web app", change: "added" },
      { id: "api", kind: "container", label: "API", change: "changed" },
      { id: "db", kind: "database", label: "Database" },
    ],
    edges: [
      { source: "web", target: "api" },
      { source: "api", target: "db" },
      { source: "db", target: "db", change: "changed" },
    ],
  };

  it("is false for every connection of a diagram without change marks", () => {
    expect(isChangeDiagram(erd)).toBe(false);
    expect(erd.edges.map((edge) => isContextConnection(erd, edge))).toEqual([false]);
  });

  it("marks the connections that carry no change and join no added element", () => {
    expect(isChangeDiagram(changed)).toBe(true);
    expect(changed.edges.map((edge) => isContextConnection(changed, edge))).toEqual([false, true, false]);
  });

  it("flows into the edge data of the layout", async () => {
    const { edges } = await layoutShapeDiagram({ ...changed, edges: changed.edges.slice(0, 2) });
    expect(edges.map((edge) => edge.data?.isContext)).toEqual([false, true]);
  });
});

describe("erdMarkers", () => {
  it("picks the marker per cardinality and tone", () => {
    expect(erdMarkers({ cardinality: { source: "many", target: "one" } }, false)).toEqual({ markerStart: "crow-many-rest", markerEnd: "crow-one-rest" });
    expect(erdMarkers({ cardinality: { source: "many", target: "one" } }, true)).toEqual({ markerStart: "crow-many-lit", markerEnd: "crow-one-lit" });
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
    expect(edges.find((edge) => edge.id === "customer->web")!).toMatchObject({ markerEnd: { color: "#6b7280" }, data: { isMuted: true } });
  });
});
