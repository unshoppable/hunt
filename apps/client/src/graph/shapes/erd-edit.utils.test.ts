import { describe, expect, it } from "vitest";
import type { ShapeDiagram } from "./shape-diagram.types";
import { addColumn, addTable, emptyErd, moveColumn, newColumnName, relationshipsOf, removeColumn, removeTable, serializeShapeDiagram, tableIdFor, updateColumn, updateTable } from "./erd-edit.utils";
import { parseShapeDiagram } from "./shape-schema.utils";

const erd: ShapeDiagram = {
  type: "erd",
  title: "Shop",
  nodes: [
    { id: "orders", kind: "table", label: "orders", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }, { name: "customer_id", type: "uuid", isForeignKey: true }], change: "changed" },
    { id: "customers", kind: "table", label: "customers", description: "People who buy", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }, { name: "email", type: "text" }] },
  ],
  edges: [{ source: "orders", target: "customers", sourceColumn: "customer_id", targetColumn: "id", cardinality: { source: "many", target: "one" }, label: "belongs to" }],
};

describe("tableIdFor", () => {
  it("derives a kebab-case id and keeps it unique", () => {
    expect(tableIdFor("Order Items", [])).toBe("order-items");
    expect(tableIdFor("  ***  ", [])).toBe("table");
    expect(tableIdFor("orders", ["orders"])).toBe("orders-2");
    expect(tableIdFor("orders", ["orders", "orders-2"])).toBe("orders-3");
  });
});

describe("addTable / removeTable", () => {
  it("adds a table with an id primary key, marked as added, and removes it with its relationships", () => {
    const added = addTable(erd, "order_items");
    expect(added.id).toBe("order-items");
    expect(added.diagram.nodes[2]).toEqual({ id: "order-items", kind: "table", label: "order_items", columns: [{ name: "id", type: "uuid", isPrimaryKey: true }], change: "added" });
    expect(erd.nodes).toHaveLength(2);

    const removed = removeTable(erd, "customers");
    expect(removed.nodes.map((node) => node.id)).toEqual(["orders"]);
    expect(removed.edges).toEqual([]);
  });
});

describe("updateTable", () => {
  it("renames, sets and clears the description and ignores an empty name", () => {
    const renamed = updateTable(erd, "orders", { label: " purchases " });
    expect(renamed.nodes[0].label).toBe("purchases");
    expect(updateTable(erd, "orders", { label: "  " }).nodes[0].label).toBe("orders");
    expect(updateTable(erd, "orders", { description: "Placed orders" }).nodes[0].description).toBe("Placed orders");
    expect(updateTable(erd, "customers", { description: "" }).nodes[1]).not.toHaveProperty("description");
  });
});

describe("columns", () => {
  it("appends a column with a free name", () => {
    const next = addColumn(erd, "customers");
    expect(next.nodes[1].columns).toHaveLength(3);
    expect(next.nodes[1].columns![2]).toEqual({ name: "column", type: "text" });
    expect(newColumnName(next.nodes[1])).toBe("column_2");
  });

  it("renames a column on its relationships too and refuses an empty or taken name", () => {
    const renamed = updateColumn(erd, "customers", 0, { name: "customer_id" });
    expect(renamed.nodes[1].columns![0].name).toBe("customer_id");
    expect(renamed.edges[0].targetColumn).toBe("customer_id");
    expect(updateColumn(erd, "customers", 0, { name: "email" }).nodes[1].columns![0].name).toBe("id");
    expect(updateColumn(erd, "customers", 0, { name: " " }).nodes[1].columns![0].name).toBe("id");
    expect(updateColumn(erd, "customers", 5, { name: "x" })).toBe(erd);
  });

  it("changes the type and the key flags, dropping a cleared flag", () => {
    const next = updateColumn(erd, "orders", 1, { type: " text ", isForeignKey: false, isPrimaryKey: true });
    expect(next.nodes[0].columns![1]).toEqual({ name: "customer_id", type: "text", isPrimaryKey: true });
  });

  it("removes a column with the relationships on it", () => {
    const next = removeColumn(erd, "orders", 1);
    expect(next.nodes[0].columns).toEqual([{ name: "id", type: "uuid", isPrimaryKey: true }]);
    expect(next.edges).toEqual([]);
    expect(removeColumn(erd, "customers", 1).edges).toHaveLength(1);
  });

  it("moves a column up or down and stays put at the ends", () => {
    expect(moveColumn(erd, "customers", 1, -1).nodes[1].columns!.map((column) => column.name)).toEqual(["email", "id"]);
    expect(moveColumn(erd, "customers", 0, -1).nodes[1].columns!.map((column) => column.name)).toEqual(["id", "email"]);
    expect(moveColumn(erd, "customers", 1, 1).nodes[1].columns!.map((column) => column.name)).toEqual(["id", "email"]);
  });
});

describe("relationshipsOf", () => {
  it("lists the edges a table takes part in", () => {
    expect(relationshipsOf(erd, "customers")).toHaveLength(1);
    expect(relationshipsOf(addTable(erd, "x").diagram, "x")).toEqual([]);
  });
});

describe("serializeShapeDiagram", () => {
  it("writes the file the agent would write and round-trips through the parser", () => {
    const text = serializeShapeDiagram(erd);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("undefined");
    expect(text.indexOf('"type"')).toBeLessThan(text.indexOf('"title"'));
    expect(text.indexOf('"kind"')).toBeLessThan(text.indexOf('"label"'));
    const parsed = parseShapeDiagram(JSON.parse(text), "erd");
    expect(parsed.problems).toEqual([]);
    expect(parsed.diagram).toEqual(erd);
    expect(serializeShapeDiagram(parsed.diagram)).toBe(text);
    expect(JSON.parse(serializeShapeDiagram(emptyErd()))).toEqual({ type: "erd", nodes: [], edges: [] });
  });
});
