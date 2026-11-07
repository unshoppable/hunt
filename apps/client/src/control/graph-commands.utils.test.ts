import { describe, expect, it } from "vitest";
import type { ShapeDiagram } from "../graph/shapes/shape-diagram.types";
import { erdTables, unchangedTableIds, unknownTableIds } from "./graph-commands.utils";

const ERD: ShapeDiagram = {
  type: "erd",
  nodes: [
    { id: "users", kind: "table", label: "users" },
    { id: "orders", kind: "table", label: "orders", change: "added" },
    { id: "items", kind: "table", label: "items", change: "changed" },
  ],
  edges: [],
};

describe("erdTables", () => {
  it("lists every table with its change mark, if it has one", () => {
    expect(erdTables(ERD)).toEqual([{ id: "users" }, { id: "orders", change: "added" }, { id: "items", change: "changed" }]);
  });
});

describe("unchangedTableIds", () => {
  it("lists the tables the session neither added nor changed", () => {
    expect(unchangedTableIds(ERD)).toEqual(["users"]);
  });
});

describe("unknownTableIds", () => {
  it("lists the ids without a table, in their order", () => {
    expect(unknownTableIds(ERD, ["payments", "users", "carts"])).toEqual(["payments", "carts"]);
    expect(unknownTableIds(ERD, ["orders"])).toEqual([]);
  });
});
