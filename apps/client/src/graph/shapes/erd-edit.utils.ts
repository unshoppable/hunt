import type { ShapeDiagram, ShapeEdge, ShapeNode, TableColumn } from "./shape-diagram.types";

/**
 * Edits of an ERD as pure functions: every one returns a new diagram and leaves the given one alone, so the panel
 * can show the result at once and write the file afterwards. Relationships follow the columns they are on: a
 * renamed column keeps its relationships, a removed column or table takes its relationships with it.
 */

/** An empty ERD, the starting point when a table is added before the agent generated a diagram. */
export function emptyErd(): ShapeDiagram {
  return { type: "erd", nodes: [], edges: [] };
}

/** Kebab-case id derived from a table's name as the schema requires it, made unique among `taken` with a counter. */
export function tableIdFor(label: string, taken: Iterable<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "table";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let counter = 2;
  while (used.has(`${base}-${counter}`)) {
    counter++;
  }
  return `${base}-${counter}`;
}

/** The name for a new column of `table`: `column`, or `column_2` and so on while the table has that name already. */
export function newColumnName(table: ShapeNode): string {
  const taken = new Set((table.columns ?? []).map((column) => column.name));
  if (!taken.has("column")) return "column";
  let counter = 2;
  while (taken.has(`column_${counter}`)) {
    counter++;
  }
  return `column_${counter}`;
}

/** Adds a table named `label` with an `id` primary key as its first column; returns the diagram and the new table's id. */
export function addTable(diagram: ShapeDiagram, label: string): { diagram: ShapeDiagram; id: string } {
  const id = tableIdFor(label, diagram.nodes.map((node) => node.id));
  const table: ShapeNode = { id, kind: "table", label, columns: [{ name: "id", type: "uuid", isPrimaryKey: true }], change: "added" };
  return { diagram: { ...diagram, nodes: [...diagram.nodes, table] }, id };
}

/** Removes the table `id` and every relationship it takes part in. */
export function removeTable(diagram: ShapeDiagram, id: string): ShapeDiagram {
  return { ...diagram, nodes: diagram.nodes.filter((node) => node.id !== id), edges: diagram.edges.filter((edge) => edge.source !== id && edge.target !== id) };
}

/** Sets the name or description of the table `id`; an empty description removes the field. */
export function updateTable(diagram: ShapeDiagram, id: string, patch: { label?: string; description?: string }): ShapeDiagram {
  return mapTable(diagram, id, (table) => {
    const next = { ...table };
    if (patch.label !== undefined && patch.label.trim()) {
      next.label = patch.label.trim();
    }
    if (patch.description !== undefined) {
      if (patch.description.trim()) {
        next.description = patch.description.trim();
      } else {
        delete next.description;
      }
    }
    return next;
  });
}

/** Appends a `text` column with a free name to the table `id`. */
export function addColumn(diagram: ShapeDiagram, id: string): ShapeDiagram {
  return mapTable(diagram, id, (table) => ({ ...table, columns: [...(table.columns ?? []), { name: newColumnName(table), type: "text" }] }));
}

/**
 * Changes the column at `index` of the table `id`: a new name (unless empty or taken by another column of the
 * table) renames it on its relationships too; a cleared key flag drops the field.
 */
export function updateColumn(diagram: ShapeDiagram, id: string, index: number, patch: Partial<TableColumn>): ShapeDiagram {
  const table = diagram.nodes.find((node) => node.id === id);
  const columns = table?.columns ?? [];
  const current = columns[index];
  if (!table || !current) return diagram;
  const next: TableColumn = { ...current };
  const name = patch.name?.trim();
  const isRenamed = name !== undefined && name !== current.name;
  if (isRenamed && name && !columns.some((column) => column.name === name)) {
    next.name = name;
  }
  if (patch.type !== undefined) {
    next.type = patch.type.trim();
  }
  for (const flag of ["isPrimaryKey", "isForeignKey"] as const) {
    if (patch[flag] === undefined) continue;
    if (patch[flag]) {
      next[flag] = true;
    } else {
      delete next[flag];
    }
  }
  const nodes = diagram.nodes.map((node) => (node.id === id ? { ...node, columns: columns.map((column, position) => (position === index ? next : column)) } : node));
  const edges = next.name === current.name ? diagram.edges : diagram.edges.map((edge) => renameOnEdge(edge, id, current.name, next.name));
  return { ...diagram, nodes, edges };
}

/** Removes the column at `index` of the table `id` and the relationships on it. */
export function removeColumn(diagram: ShapeDiagram, id: string, index: number): ShapeDiagram {
  const table = diagram.nodes.find((node) => node.id === id);
  const columns = table?.columns ?? [];
  const column = columns[index];
  if (!table || !column) return diagram;
  const nodes = diagram.nodes.map((node) => (node.id === id ? { ...node, columns: columns.filter((_, position) => position !== index) } : node));
  const edges = diagram.edges.filter((edge) => !(edge.source === id && edge.sourceColumn === column.name) && !(edge.target === id && edge.targetColumn === column.name));
  return { ...diagram, nodes, edges };
}

/** Moves the column at `index` of the table `id` one row up (`-1`) or down (`1`); unchanged at the ends. */
export function moveColumn(diagram: ShapeDiagram, id: string, index: number, delta: -1 | 1): ShapeDiagram {
  return mapTable(diagram, id, (table) => {
    const columns = [...(table.columns ?? [])];
    const target = index + delta;
    if (index < 0 || index >= columns.length || target < 0 || target >= columns.length) return table;
    [columns[index], columns[target]] = [columns[target], columns[index]];
    return { ...table, columns };
  });
}

/** The relationships of the table `id`, with the column of that table each one is on. */
export function relationshipsOf(diagram: ShapeDiagram, id: string): ShapeEdge[] {
  return diagram.edges.filter((edge) => edge.source === id || edge.target === id);
}

/**
 * The file content of a diagram as the agent writes it: two-space indented, the fields in the order the system
 * prompt lists them, optional fields left out where they do not apply.
 */
export function serializeShapeDiagram(diagram: ShapeDiagram): string {
  const content = {
    type: diagram.type,
    title: diagram.title,
    nodes: diagram.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      description: node.description,
      parent: node.parent,
      actor: node.actor,
      columns: node.columns?.map((column) => ({ name: column.name, type: column.type, isPrimaryKey: column.isPrimaryKey, isForeignKey: column.isForeignKey })),
      change: node.change,
    })),
    groups: diagram.groups?.map((group) => ({ id: group.id, label: group.label, change: group.change })),
    edges: diagram.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      label: edge.label,
      description: edge.description,
      sourceColumn: edge.sourceColumn,
      targetColumn: edge.targetColumn,
      cardinality: edge.cardinality,
      change: edge.change,
    })),
  };
  return `${JSON.stringify(content, null, 2)}\n`;
}

function mapTable(diagram: ShapeDiagram, id: string, update: (table: ShapeNode) => ShapeNode): ShapeDiagram {
  return { ...diagram, nodes: diagram.nodes.map((node) => (node.id === id ? update(node) : node)) };
}

function renameOnEdge(edge: ShapeEdge, tableId: string, from: string, to: string): ShapeEdge {
  const next = { ...edge };
  if (edge.source === tableId && edge.sourceColumn === from) {
    next.sourceColumn = to;
  }
  if (edge.target === tableId && edge.targetColumn === from) {
    next.targetColumn = to;
  }
  return next;
}
