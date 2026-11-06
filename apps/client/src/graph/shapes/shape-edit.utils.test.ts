import { describe, expect, it } from "vitest";
import type { ShapeDiagram } from "./shape-diagram.types";
import { addEdge, addGroup, addNode, clearPositions, emptyDiagram, removeEdge, removeGroup, removeNode, setBends, setPositions, updateEdge, updateGroup, updateNode } from "./shape-edit.utils";

const states: ShapeDiagram = {
  type: "states",
  nodes: [
    { id: "start", kind: "start", label: "Start" },
    { id: "open", kind: "state", label: "Open" },
  ],
  edges: [{ source: "start", target: "open", label: "created" }],
};

describe("elements", () => {
  it("adds an element with a unique id, marked as added, at the given position", () => {
    const first = addNode(states, "state", "Open", { x: 10.4, y: 20.6 });
    expect(first.id).toBe("open-2");
    expect(first.diagram.nodes[2]).toEqual({ id: "open-2", kind: "state", label: "Open", change: "added", position: { x: 10, y: 21 } });
    expect(addNode(emptyDiagram("erd"), "table", "Orders").diagram.nodes[0].columns).toEqual([{ name: "id", type: "uuid", isPrimaryKey: true }]);
    expect(states.nodes).toHaveLength(2);
  });

  it("changes the fields of an element, dropping cleared ones and ignoring an empty name or an unknown boundary", () => {
    const grouped = addGroup(states, "Shop").diagram;
    const next = updateNode(grouped, "open", { label: " Opened ", description: "Waiting", kind: "end", parent: "shop", change: "changed" });
    expect(next.nodes[1]).toEqual({ id: "open", kind: "end", label: "Opened", description: "Waiting", parent: "shop", change: "changed" });
    const cleared = updateNode(next, "open", { label: " ", description: "", parent: null, change: null });
    expect(cleared.nodes[1]).toEqual({ id: "open", kind: "end", label: "Opened" });
    expect(updateNode(next, "open", { parent: "nope" }).nodes[1].parent).toBe("shop");
  });

  it("removes an element with its connections", () => {
    const next = removeNode(states, "open");
    expect(next.nodes.map((node) => node.id)).toEqual(["start"]);
    expect(next.edges).toEqual([]);
  });
});

describe("connections", () => {
  it("connects two elements once per direction, marked as added", () => {
    const added = addEdge(states, "open", "start");
    expect(added.id).toBe("open->start");
    expect(added.diagram.edges[1]).toEqual({ source: "open", target: "start", change: "added" });
    expect(addEdge(states, "start", "open")).toEqual({ diagram: states, id: null });
    expect(addEdge(states, "start", "missing").id).toBeNull();
  });

  it("changes and removes a connection by its id", () => {
    const next = updateEdge(states, "start->open", { label: "", description: "Opens it", change: "changed" });
    expect(next.edges[0]).toEqual({ source: "start", target: "open", description: "Opens it", change: "changed" });
    expect(removeEdge(next, "start->open").edges).toEqual([]);
  });
});

describe("boundaries", () => {
  it("adds, renames and removes a boundary, whose elements stay", () => {
    const added = addGroup(states, "Start");
    expect(added.id).toBe("start-2");
    const inside = updateNode(updateGroup(added.diagram, added.id, { label: "Lifecycle", change: null }), "open", { parent: added.id });
    expect(inside.groups).toEqual([{ id: "start-2", label: "Lifecycle" }]);
    const removed = removeGroup(inside, added.id);
    expect(removed.groups).toBeUndefined();
    expect(removed.nodes[1].parent).toBeUndefined();
  });
});

describe("positions", () => {
  it("places the named elements rounded and drops every position again", () => {
    const placed = setPositions(states, new Map([["open", { x: 1.6, y: 2.2 }]]));
    expect(placed.nodes.map((node) => node.position)).toEqual([undefined, { x: 2, y: 2 }]);
    expect(clearPositions(placed).nodes.some((node) => "position" in node)).toBe(false);
  });

  it("fixes a connection's corners rounded, lets Hunt route it again, and drops them with the positions", () => {
    const bent = setBends(states, "start->open", [{ x: 10.4, y: 0 }, { x: 10.4, y: 80.6 }]);
    expect(bent.edges[0].bends).toEqual([{ x: 10, y: 0 }, { x: 10, y: 81 }]);
    expect("bends" in setBends(bent, "start->open", null).edges[0]).toBe(false);
    expect("bends" in clearPositions(bent).edges[0]).toBe(false);
  });
});
