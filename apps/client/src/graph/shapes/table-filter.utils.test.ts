import { describe, expect, it } from "vitest";
import type { ShapeDiagram } from "./shape-diagram.types";
import { withoutTables } from "./table-filter.utils";

const erd: ShapeDiagram = {
  type: "erd",
  nodes: [
    { id: "customer", kind: "table", label: "customer", parent: "sales" },
    { id: "order", kind: "table", label: "order", parent: "sales" },
    { id: "audit", kind: "table", label: "audit", parent: "logs" },
  ],
  groups: [
    { id: "sales", label: "Sales" },
    { id: "logs", label: "Logs" },
  ],
  edges: [
    { source: "order", target: "customer", sourceColumn: "customer_id", targetColumn: "id" },
    { source: "audit", target: "order", sourceColumn: "order_id", targetColumn: "id" },
  ],
};

describe("withoutTables", () => {
  it("returns the diagram itself when no shown table is hidden", () => {
    expect(withoutTables(erd, new Set(["gone"]))).toBe(erd);
  });

  it("drops the hidden tables, their relationships and the groups left empty", () => {
    const shown = withoutTables(erd, new Set(["audit"]));
    expect(shown.nodes.map((node) => node.id)).toEqual(["customer", "order"]);
    expect(shown.edges).toEqual([erd.edges[0]]);
    expect(shown.groups).toEqual([{ id: "sales", label: "Sales" }]);
  });

  it("keeps a diagram without groups free of them", () => {
    const { groups: _groups, ...flat } = erd;
    expect(withoutTables(flat, new Set(["customer"]))).not.toHaveProperty("groups");
  });
});
