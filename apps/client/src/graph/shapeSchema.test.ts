import { describe, expect, it } from "vitest";
import { parseShapeDiagram } from "./shapeSchema";

const context = {
  type: "c4-context",
  title: "Shop",
  nodes: [
    { id: "customer", kind: "person", label: "Customer", description: "Buys products" },
    { id: "shop", kind: "system", label: "Shop", change: "changed" },
    { id: "payments", kind: "externalSystem", label: "Payment provider" },
  ],
  edges: [
    { source: "customer", target: "shop", label: "orders" },
    { source: "shop", target: "payments", label: "charges cards", description: "Sends the card token over HTTPS.", change: "added" },
  ],
};

const container = {
  type: "c4-container",
  groups: [{ id: "shop", label: "Shop", change: "changed" }],
  nodes: [
    { id: "customer", kind: "person", label: "Customer" },
    { id: "web", kind: "container", label: "Web app", description: "React", parent: "shop" },
    { id: "api", kind: "container", label: "API", description: "Node, Express", parent: "shop", change: "changed" },
    { id: "db", kind: "database", label: "Orders DB", description: "Postgres", parent: "shop" },
    { id: "events", kind: "queue", label: "Events", parent: "shop" },
    { id: "payments", kind: "externalSystem", label: "Payment provider" },
  ],
  edges: [
    { source: "customer", target: "web", label: "uses" },
    { source: "web", target: "api", label: "calls over HTTPS" },
    { source: "api", target: "db", label: "reads orders" },
    { source: "api", target: "events", label: "publishes" },
    { source: "api", target: "payments", label: "charges" },
  ],
};

const states = {
  type: "states",
  nodes: [
    { id: "start", kind: "start", label: "Start" },
    { id: "open", kind: "state", label: "Open" },
    { id: "paid", kind: "state", label: "Paid", change: "added" },
    { id: "end", kind: "end", label: "End" },
  ],
  edges: [
    { source: "start", target: "open", label: "created" },
    { source: "open", target: "paid", label: "payment received" },
    { source: "paid", target: "end", label: "shipped" },
  ],
};

const erd = {
  type: "erd",
  nodes: [
    { id: "customers", kind: "table", label: "customers", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }, { name: "email", type: "text" }] },
    { id: "orders", kind: "table", label: "orders", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }, { name: "customer_id", type: "uuid", isForeignKey: true }] },
  ],
  edges: [{ source: "orders", target: "customers", sourceColumn: "customer_id", targetColumn: "id", cardinality: { source: "many", target: "one" }, label: "belongs to" }],
};

const process = {
  type: "process",
  nodes: [
    { id: "start", kind: "start", label: "Start" },
    { id: "check", kind: "action", label: "Check stock", actor: "Warehouse" },
    { id: "in-stock", kind: "decision", label: "In stock?" },
    { id: "ship", kind: "action", label: "Ship", actor: "Warehouse" },
    { id: "end", kind: "end", label: "End" },
  ],
  edges: [
    { source: "start", target: "check" },
    { source: "check", target: "in-stock" },
    { source: "in-stock", target: "ship", label: "yes" },
    { source: "in-stock", target: "end", label: "no" },
    { source: "ship", target: "end" },
  ],
};

describe("parseShapeDiagram", () => {
  it("accepts a schema-conforming diagram of every type without problems", () => {
    expect(parseShapeDiagram(context, "c4-context")).toEqual({ diagram: context, problems: [] });
    expect(parseShapeDiagram(container, "c4-container")).toEqual({ diagram: container, problems: [] });
    expect(parseShapeDiagram(states, "states")).toEqual({ diagram: states, problems: [] });
    expect(parseShapeDiagram(erd, "erd")).toEqual({ diagram: erd, problems: [] });
    expect(parseShapeDiagram(process, "process")).toEqual({ diagram: process, problems: [] });
  });

  it("yields an empty diagram for a non-object or a file of another type", () => {
    expect(parseShapeDiagram(null, "states")).toEqual({ diagram: { type: "states", nodes: [], edges: [] }, problems: [expect.stringContaining("must be an object")] });
    expect(parseShapeDiagram([], "states").problems).toHaveLength(1);
    const other = parseShapeDiagram(context, "c4-container");
    expect(other.diagram).toEqual({ type: "c4-container", nodes: [], edges: [] });
    expect(other.problems).toEqual([expect.stringContaining('"c4-context" instead of "c4-container"')]);
  });

  it("drops nodes without a valid id, a label or an allowed kind, and duplicate ids", () => {
    const parsed = parseShapeDiagram(
      {
        type: "c4-context",
        nodes: [
          { id: "Shop", kind: "system", label: "Shop" },
          { id: "shop", kind: "system" },
          { id: "shop", kind: "container", label: "Shop" },
          { id: "shop", kind: "system", label: "Shop" },
          { id: "shop", kind: "system", label: "Shop again" },
          "not an object",
        ],
        edges: [],
      },
      "c4-context",
    );
    expect(parsed.diagram.nodes).toEqual([{ id: "shop", kind: "system", label: "Shop" }]);
    expect(parsed.problems).toHaveLength(5);
    expect(parsed.problems[2]).toContain('"container"');
  });

  it("drops a table without a valid column and coerces the column flags", () => {
    const parsed = parseShapeDiagram(
      {
        type: "erd",
        nodes: [
          { id: "empty", kind: "table", label: "empty", columns: [{ name: "id" }] },
          { id: "none", kind: "table", label: "none" },
          { id: "users", kind: "table", label: "users", columns: [{ name: "id", type: "uuid", isPrimaryKey: "yes" }, { type: "text" }, { name: "name", type: "text", isForeignKey: 0 }] },
        ],
        edges: [],
      },
      "erd",
    );
    expect(parsed.diagram.nodes).toEqual([{ id: "users", kind: "table", label: "users", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }, { name: "name", type: "text" }] }]);
    expect(parsed.problems.filter((problem) => problem.includes("dropped"))).toHaveLength(4);
  });

  it("clears a parent that names no group and keeps groups with a valid id and label only", () => {
    const parsed = parseShapeDiagram(
      {
        type: "c4-container",
        groups: [{ id: "shop", label: "Shop" }, { id: "Bad Id", label: "x" }, { id: "no-label" }],
        nodes: [{ id: "api", kind: "container", label: "API", parent: "shop" }, { id: "web", kind: "container", label: "Web", parent: "missing" }],
        edges: [],
      },
      "c4-container",
    );
    expect(parsed.diagram.groups).toEqual([{ id: "shop", label: "Shop" }]);
    expect(parsed.diagram.nodes.map((node) => node.parent)).toEqual(["shop", undefined]);
    expect(parsed.problems).toHaveLength(3);
  });

  it("clears a change that is neither added nor changed", () => {
    const parsed = parseShapeDiagram(
      {
        type: "states",
        groups: [{ id: "g", label: "G", change: "removed" }],
        nodes: [{ id: "a", kind: "state", label: "A", change: "new" }, { id: "b", kind: "state", label: "B", change: "added" }],
        edges: [{ source: "a", target: "b", label: "go", change: true }],
      },
      "states",
    );
    expect(parsed.diagram.groups![0].change).toBeUndefined();
    expect(parsed.diagram.nodes.map((node) => node.change)).toEqual([undefined, "added"]);
    expect(parsed.diagram.edges[0].change).toBeUndefined();
    expect(parsed.problems).toHaveLength(3);
  });

  it("drops edges with unknown endpoints and duplicate edges", () => {
    const parsed = parseShapeDiagram(
      {
        type: "c4-context",
        nodes: [{ id: "a", kind: "system", label: "A" }, { id: "b", kind: "system", label: "B" }],
        edges: [{ source: "a", target: "c", label: "x" }, { source: "a" }, { source: "a", target: "b", label: "x" }, { source: "a", target: "b", label: "y" }],
      },
      "c4-context",
    );
    expect(parsed.diagram.edges).toEqual([{ source: "a", target: "b", label: "x" }]);
    expect(parsed.problems).toEqual([expect.stringContaining('unknown node "c"'), expect.stringContaining("lacks a source or target"), expect.stringContaining("more than once")]);
  });

  it("drops erd edges whose columns do not exist on their tables or whose cardinality is invalid", () => {
    const parsed = parseShapeDiagram(
      {
        type: "erd",
        nodes: erd.nodes,
        edges: [
          { source: "orders", target: "customers", sourceColumn: "customer", targetColumn: "id", cardinality: { source: "many", target: "one" } },
          { source: "orders", target: "customers", sourceColumn: "customer_id", targetColumn: "mail", cardinality: { source: "many", target: "one" } },
          { source: "orders", target: "customers", sourceColumn: "customer_id", targetColumn: "id", cardinality: { source: "many", target: "several" } },
          { source: "orders", target: "customers", sourceColumn: "customer_id", targetColumn: "id" },
          { source: "orders", target: "customers", sourceColumn: "customer_id", targetColumn: "id", cardinality: { source: "many", target: "one" } },
        ],
      },
      "erd",
    );
    expect(parsed.diagram.edges).toEqual([{ source: "orders", target: "customers", sourceColumn: "customer_id", targetColumn: "id", cardinality: { source: "many", target: "one" } }]);
    expect(parsed.problems).toHaveLength(4);
  });

  it("keeps but reports a transition or a decision edge without a label", () => {
    const transitions = parseShapeDiagram({ type: "states", nodes: states.nodes, edges: [{ source: "start", target: "open" }] }, "states");
    expect(transitions.diagram.edges).toEqual([{ source: "start", target: "open" }]);
    expect(transitions.problems).toEqual([expect.stringContaining("no event label")]);
    const decisions = parseShapeDiagram({ type: "process", nodes: process.nodes, edges: [{ source: "in-stock", target: "ship" }, { source: "check", target: "in-stock" }] }, "process");
    expect(decisions.diagram.edges).toHaveLength(2);
    expect(decisions.problems).toEqual([expect.stringContaining("leaves a decision without an answer label")]);
  });

  it("ignores unknown fields and keeps the title only when it is a string", () => {
    const parsed = parseShapeDiagram({ ...states, title: 42, color: "red", nodes: [{ ...states.nodes[1], icon: "x" }], edges: [] }, "states");
    expect(parsed.diagram.title).toBeUndefined();
    expect(parsed.diagram.nodes).toEqual([{ id: "open", kind: "state", label: "Open" }]);
    expect(parsed.problems).toEqual([]);
  });
});
