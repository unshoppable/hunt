import type { ShapeChange, ShapeDiagram, ShapeKind } from "./shape-diagram.types";
import { DANGER_BUTTON_XS, ICON_BUTTON_XS } from "../../ui/buttons.constants";
import { confirmDestructive } from "../../ui/confirm.utils";
import { Dropdown } from "../../ui/Dropdown";
import { CloseIcon, TrashIcon } from "../../ui/Icons";
import { KINDS_BY_TYPE } from "../diagram-types.constants";
import { CommitInput, CommitTextarea, INPUT, SECTION_LABEL } from "./EditorFields";
import { shapeEdgeId } from "./shape-diagram.utils";
import { removeEdge, removeGroup, removeNode, updateEdge, updateGroup, updateNode } from "./shape-edit.utils";

/** What the editor beside the canvas shows: an element, a connection (by `shapeEdgeId`) or a boundary. */
export type ShapeSelection = { kind: "node" | "edge" | "group"; id: string };

/** Names of the element kinds as the editor lists them. */
export const KIND_NAMES: Record<ShapeKind, string> = {
  person: "Person",
  system: "System",
  externalSystem: "External system",
  container: "Container",
  database: "Database",
  queue: "Queue",
  start: "Start",
  end: "End",
  state: "State",
  action: "Action",
  decision: "Decision",
  table: "Table",
};

const NONE = "none";
const CHANGE_OPTIONS = [
  { id: NONE, name: "Unchanged" },
  { id: "added", name: "Added" },
  { id: "changed", name: "Changed" },
];
const CARDINALITY_OPTIONS = [
  { id: "one", name: "One" },
  { id: "many", name: "Many" },
];
const SELECT = `${INPUT} flex items-center justify-between`;

/**
 * The editor of one element, connection or boundary of a shape diagram beside the canvas. Every field commits on blur,
 * Enter or a pick and hands the changed diagram to `onChange`, which the panel shows at once and writes to the file.
 * Deleting an element asks first when connections go with it.
 */
export function ShapeElementEditor({
  diagram,
  selection,
  isNew,
  onChange,
  onClose,
}: {
  diagram: ShapeDiagram;
  selection: ShapeSelection;
  /** The element was just added: the name field takes the focus with its text selected. */
  isNew: boolean;
  onChange: (next: ShapeDiagram) => void;
  onClose: () => void;
}) {
  const nameOf = (id: string) => diagram.nodes.find((node) => node.id === id)?.label ?? id;
  const remove = async (next: ShapeDiagram, question: string | null) => {
    if (question && !(await confirmDestructive(question))) return;
    onChange(next);
    onClose();
  };

  if (selection.kind === "node") {
    const node = diagram.nodes.find((candidate) => candidate.id === selection.id);
    if (!node) return null;
    const connections = diagram.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length;
    const groups = diagram.groups ?? [];
    return (
      <EditorFrame title={KIND_NAMES[node.kind]} onClose={onClose} deleteLabel="Delete element" onDelete={() => void remove(removeNode(diagram, node.id), connections ? `Delete "${node.label}" and its ${countOf(connections, "connection")}?` : null)}>
        <Field label="Name">
          <CommitInput value={node.label} onCommit={(label) => onChange(updateNode(diagram, node.id, { label }))} ariaLabel="Element name" autoFocus={isNew} className={`${INPUT} font-medium`} />
        </Field>
        <Field label="Description">
          <CommitTextarea value={node.description ?? ""} onCommit={(description) => onChange(updateNode(diagram, node.id, { description }))} placeholder="Second line under the name" />
        </Field>
        {node.kind !== "table" ? (
          <Field label="Kind">
            <Dropdown
              title="Element kind"
              value={node.kind}
              options={KINDS_BY_TYPE[diagram.type].filter((kind) => kind !== "table").map((kind) => ({ id: kind, name: KIND_NAMES[kind] }))}
              onChange={(kind) => onChange(updateNode(diagram, node.id, { kind: kind as ShapeKind }))}
              className={SELECT}
            />
          </Field>
        ) : null}
        {diagram.type === "process" && node.kind === "action" ? (
          <Field label="Actor">
            <CommitInput value={node.actor ?? ""} onCommit={(actor) => onChange(updateNode(diagram, node.id, { actor }))} ariaLabel="Actor" className={INPUT} />
          </Field>
        ) : null}
        {groups.length ? (
          <Field label="Boundary">
            <Dropdown
              title="Boundary"
              value={node.parent ?? NONE}
              options={[{ id: NONE, name: "None" }, ...groups.map((group) => ({ id: group.id, name: group.label }))]}
              onChange={(parent) => onChange(updateNode(diagram, node.id, { parent: parent === NONE ? null : parent }))}
              className={SELECT}
            />
          </Field>
        ) : null}
        <ChangeField value={node.change} onChange={(change) => onChange(updateNode(diagram, node.id, { change }))} />
      </EditorFrame>
    );
  }

  if (selection.kind === "group") {
    const group = diagram.groups?.find((candidate) => candidate.id === selection.id);
    if (!group) return null;
    return (
      <EditorFrame title="Boundary" onClose={onClose} deleteLabel="Delete boundary" onDelete={() => void remove(removeGroup(diagram, group.id), null)}>
        <Field label="Name">
          <CommitInput value={group.label} onCommit={(label) => onChange(updateGroup(diagram, group.id, { label }))} ariaLabel="Boundary name" autoFocus={isNew} className={`${INPUT} font-medium`} />
        </Field>
        <ChangeField value={group.change} onChange={(change) => onChange(updateGroup(diagram, group.id, { change }))} />
        <span className="text-neutral-500">Pick the boundary in an element's editor to move the element into it.</span>
      </EditorFrame>
    );
  }

  const edge = diagram.edges.find((candidate) => shapeEdgeId(diagram, candidate) === selection.id);
  if (!edge) return null;
  return (
    <EditorFrame title="Connection" onClose={onClose} deleteLabel="Delete connection" onDelete={() => void remove(removeEdge(diagram, selection.id), null)}>
      <p className="truncate text-neutral-300" title={`${nameOf(edge.source)} → ${nameOf(edge.target)}`}>
        {nameOf(edge.source)} <span className="text-neutral-500">→</span> {nameOf(edge.target)}
      </p>
      <Field label="Label">
        <CommitInput value={edge.label ?? ""} onCommit={(label) => onChange(updateEdge(diagram, selection.id, { label }))} ariaLabel="Connection label" autoFocus={isNew} className={INPUT} />
      </Field>
      <Field label="Description">
        <CommitTextarea value={edge.description ?? ""} onCommit={(description) => onChange(updateEdge(diagram, selection.id, { description }))} placeholder="What the connection carries and why" />
      </Field>
      {diagram.type === "erd" && edge.cardinality ? (
        <div className="grid grid-cols-2 gap-2">
          {(["source", "target"] as const).map((end) => (
            <Field key={end} label={end === "source" ? "Source rows" : "Target rows"}>
              <Dropdown
                title={end === "source" ? "Source cardinality" : "Target cardinality"}
                value={edge.cardinality?.[end] ?? "one"}
                options={CARDINALITY_OPTIONS}
                onChange={(value) => onChange(updateEdge(diagram, selection.id, { cardinality: { source: edge.cardinality?.source ?? "one", target: edge.cardinality?.target ?? "one", [end]: value as "one" | "many" } }))}
                className={SELECT}
              />
            </Field>
          ))}
        </div>
      ) : null}
      <ChangeField value={edge.change} onChange={(change) => onChange(updateEdge(diagram, selection.id, { change }))} />
    </EditorFrame>
  );
}

function EditorFrame({ title, onClose, deleteLabel, onDelete, children }: { title: string; onClose: () => void; deleteLabel: string; onDelete: () => void; children: React.ReactNode }) {
  return (
    <aside aria-label={`Edit ${title.toLowerCase()}`} className="flex w-[320px] shrink-0 flex-col border-l border-(--line) bg-(--surface-chat) text-[13px]">
      <div className="flex items-center gap-2 border-b border-(--line) px-3 py-2">
        <span className={`flex-1 ${SECTION_LABEL}`}>{title}</span>
        <button type="button" onClick={onClose} aria-label="Close editor" title="Close editor" className={ICON_BUTTON_XS}>
          <CloseIcon />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">{children}</div>
      <div className="flex justify-end border-t border-(--line) px-3 py-2">
        <button type="button" onClick={onDelete} className={DANGER_BUTTON_XS}>
          <TrashIcon /> {deleteLabel}
        </button>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-neutral-400">{label}</span>
      {children}
    </label>
  );
}

/** The change mark Hunt highlights the element with: none, added or changed. */
function ChangeField({ value, onChange }: { value?: ShapeChange; onChange: (change: ShapeChange | null) => void }) {
  return (
    <Field label="Change mark">
      <Dropdown title="Change mark" value={value ?? NONE} options={CHANGE_OPTIONS} onChange={(id) => onChange(id === NONE ? null : (id as ShapeChange))} className={SELECT} />
    </Field>
  );
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
