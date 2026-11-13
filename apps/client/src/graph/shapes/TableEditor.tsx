import type { ShapeDiagram, ShapeNode } from "./shape-diagram.types";
import { DANGER_BUTTON_XS, GHOST_BUTTON_XS, ICON_BUTTON_XS } from "../../ui/buttons.constants";
import { confirmDestructive } from "../../ui/confirm.utils";
import { CloseIcon, PlusIcon, TrashIcon } from "../../ui/Icons";
import { addColumn, moveColumn, relationshipsOf, removeColumn, updateColumn, updateTable } from "./erd-edit.utils";
import { ColorField, CommitInput, CommitTextarea, INPUT, SECTION_LABEL } from "./EditorFields";
import { updateNode } from "./shape-edit.utils";

/**
 * The editor of one ERD table beside the canvas: name, description, color and the columns with their types and key
 * flags, plus the relationships the table takes part in. Every field commits on blur or Enter (Escape reverts) and
 * hands the changed diagram to `onChange`, which the panel shows at once and writes to the diagram file. Removing a
 * column asks first when relationships go with it; deleting the table is the panel's `onDelete`.
 */
/**
 * The diagram without the column at `index` of the table `id` and its relationships, after asking when relationships
 * go with it; null when the user declines or the column does not exist.
 */
export async function removeColumnAfterAsking(diagram: ShapeDiagram, id: string, index: number): Promise<ShapeDiagram | null> {
  const column = diagram.nodes.find((node) => node.id === id)?.columns?.[index];
  if (!column) return null;
  const affected = relationshipsOf(diagram, id).filter((edge) => (edge.source === id && edge.sourceColumn === column.name) || (edge.target === id && edge.targetColumn === column.name));
  if (affected.length && !(await confirmDestructive(`Remove the column "${column.name}"? ${countOf(affected.length, "relationship")} on it will be removed too.`, "Remove"))) return null;
  return removeColumn(diagram, id, index);
}

export function TableEditor({
  diagram,
  table,
  isNew,
  onChange,
  onDelete,
  onClose,
}: {
  diagram: ShapeDiagram;
  table: ShapeNode;
  /** The table was just added: the name field takes the focus with its text selected. */
  isNew: boolean;
  onChange: (next: ShapeDiagram) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const columns = table.columns ?? [];
  const relationships = relationshipsOf(diagram, table.id);
  const tableName = (id: string) => diagram.nodes.find((node) => node.id === id)?.label ?? id;

  const removeColumnAt = async (index: number) => {
    const next = await removeColumnAfterAsking(diagram, table.id, index);
    if (next) onChange(next);
  };

  return (
    <aside aria-label={`Edit table ${table.label}`} className="flex w-[400px] shrink-0 flex-col border-l border-(--line) bg-(--surface-chat) text-[13px]">
      <div className="flex items-center gap-2 border-b border-(--line) px-3 py-2">
        <span className={`flex-1 ${SECTION_LABEL}`}>Table</span>
        <button type="button" onClick={onClose} aria-label="Close editor" title="Close editor" className={ICON_BUTTON_XS}>
          <CloseIcon />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400">Name</span>
          <CommitInput value={table.label} onCommit={(label) => onChange(updateTable(diagram, table.id, { label }))} ariaLabel="Table name" autoFocus={isNew} className={`${INPUT} font-medium`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400">Description</span>
          <CommitTextarea value={table.description ?? ""} onCommit={(description) => onChange(updateTable(diagram, table.id, { description }))} placeholder="What the table holds" />
        </label>
        <ColorField value={table.color} onChange={(color) => onChange(updateNode(diagram, table.id, { color }))} />

        <section className="flex flex-col gap-1.5">
          <div className="flex items-center">
            <span className={`flex-1 ${SECTION_LABEL}`}>
              Columns <span className="font-normal text-neutral-600">{columns.length}</span>
            </span>
            <button type="button" onClick={() => onChange(addColumn(diagram, table.id))} className={GHOST_BUTTON_XS}>
              <PlusIcon /> Column
            </button>
          </div>
          <ul className="flex flex-col gap-1">
            {columns.map((column, index) => (
              <li key={`${index}:${column.name}`} className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5">
                <CommitInput value={column.name} onCommit={(name) => onChange(updateColumn(diagram, table.id, index, { name }))} ariaLabel="Column name" className={INPUT} />
                <CommitInput value={column.type} onCommit={(type) => onChange(updateColumn(diagram, table.id, index, { type }))} ariaLabel="Column type" className={`${INPUT} font-mono text-[12px]`} />
                <div className="flex items-center gap-0.5">
                  <KeyToggle label="PK" title="Primary key" isOn={Boolean(column.isPrimaryKey)} onClass="border-amber-400/40 bg-amber-400/15 text-amber-300" onToggle={(isPrimaryKey) => onChange(updateColumn(diagram, table.id, index, { isPrimaryKey }))} />
                  <KeyToggle label="FK" title="Foreign key" isOn={Boolean(column.isForeignKey)} onClass="border-sky-400/40 bg-sky-400/15 text-sky-300" onToggle={(isForeignKey) => onChange(updateColumn(diagram, table.id, index, { isForeignKey }))} />
                  <div className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <RowButton title="Move up" isDisabled={index === 0} onClick={() => onChange(moveColumn(diagram, table.id, index, -1))}>
                      <ArrowIcon direction="up" />
                    </RowButton>
                    <RowButton title="Move down" isDisabled={index === columns.length - 1} onClick={() => onChange(moveColumn(diagram, table.id, index, 1))}>
                      <ArrowIcon direction="down" />
                    </RowButton>
                    <RowButton title="Remove column" onClick={() => void removeColumnAt(index)}>
                      <CloseIcon className="size-3" />
                    </RowButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-1.5">
          <span className={SECTION_LABEL}>
            Relationships <span className="font-normal text-neutral-600">{relationships.length}</span>
          </span>
          {relationships.length ? (
            <ul className="flex flex-col gap-1 text-neutral-300">
              {relationships.map((edge) => {
                const isOutgoing = edge.source === table.id;
                const own = isOutgoing ? edge.sourceColumn : edge.targetColumn;
                const other = isOutgoing ? `${tableName(edge.target)}.${edge.targetColumn}` : `${tableName(edge.source)}.${edge.sourceColumn}`;
                return (
                  <li key={`${edge.source}.${edge.sourceColumn}->${edge.target}.${edge.targetColumn}`} className="flex min-w-0 items-baseline gap-1.5 rounded-md bg-white/[0.03] px-2 py-1" title={edge.description}>
                    <span className="truncate font-mono text-[12px]">{own}</span>
                    <span className="shrink-0 text-neutral-500">{isOutgoing ? "→" : "←"}</span>
                    <span className="min-w-0 truncate font-mono text-[12px]">{other}</span>
                    {edge.label ? <span className="ml-auto shrink-0 text-[12px] text-neutral-500">{edge.label}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <span className="text-neutral-500">None; the agent adds relationships when it updates the diagram.</span>
          )}
        </section>
      </div>

      <div className="flex justify-end border-t border-(--line) px-3 py-2">
        <button type="button" onClick={onDelete} className={DANGER_BUTTON_XS}>
          <TrashIcon /> Delete table
        </button>
      </div>
    </aside>
  );
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A `PK`/`FK` toggle; `onClass` colors it while it is on. */
function KeyToggle({ label, title, isOn, onClass, onToggle }: { label: string; title: string; isOn: boolean; onClass: string; onToggle: (isOn: boolean) => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={isOn}
      onClick={() => onToggle(!isOn)}
      className={`h-6 rounded border px-1 text-[10px] font-semibold transition-colors ${isOn ? onClass : "border-white/10 text-neutral-600 hover:border-white/20 hover:text-neutral-300"}`}
    >
      {label}
    </button>
  );
}

function RowButton({ title, isDisabled = false, onClick, children }: { title: string; isDisabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={isDisabled} onClick={onClick} className="flex size-6 items-center justify-center rounded text-neutral-500 hover:bg-(--row-hover) hover:text-neutral-200 disabled:pointer-events-none disabled:opacity-30">
      {children}
    </button>
  );
}

function ArrowIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-3 ${direction === "down" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}
