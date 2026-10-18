import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ShapeDiagram, ShapeNode } from "../ipc/types";
import { DANGER_BUTTON_XS, GHOST_BUTTON_XS, ICON_BUTTON_XS } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { CloseIcon, PlusIcon, TrashIcon } from "../ui/icons";
import { addColumn, moveColumn, relationshipsOf, removeColumn, removeTable, updateColumn, updateTable } from "./erdEdit";

const INPUT = "h-7 w-full min-w-0 rounded-md border border-white/10 bg-(--surface-input) px-2 text-[13px] text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-blue-400/70";
const SECTION_LABEL = "text-[12px] font-medium tracking-wide text-neutral-500 uppercase";

/**
 * The editor of one ERD table beside the canvas: name, description and the columns with their types and key
 * flags, plus the relationships the table takes part in. Every field commits on blur or Enter (Escape reverts) and
 * hands the changed diagram to `onChange`, which the panel shows at once and writes to the diagram file. Removing a
 * column or the table asks first when relationships go with it.
 */
export function TableEditor({
  diagram,
  table,
  isNew,
  onChange,
  onClose,
}: {
  diagram: ShapeDiagram;
  table: ShapeNode;
  /** The table was just added: the name field takes the focus with its text selected. */
  isNew: boolean;
  onChange: (next: ShapeDiagram) => void;
  onClose: () => void;
}) {
  const columns = table.columns ?? [];
  const relationships = relationshipsOf(diagram, table.id);
  const tableName = (id: string) => diagram.nodes.find((node) => node.id === id)?.label ?? id;

  const removeColumnAt = async (index: number) => {
    const column = columns[index];
    const affected = relationships.filter((edge) => (edge.source === table.id && edge.sourceColumn === column.name) || (edge.target === table.id && edge.targetColumn === column.name));
    if (affected.length && !(await confirmDestructive(`Remove the column "${column.name}"? ${countOf(affected.length, "relationship")} on it will be removed too.`, "Remove"))) return;
    onChange(removeColumn(diagram, table.id, index));
  };

  const deleteTable = async () => {
    const suffix = relationships.length ? ` and its ${countOf(relationships.length, "relationship")}` : "";
    if (!(await confirmDestructive(`Delete the table "${table.label}"${suffix}?`))) return;
    onChange(removeTable(diagram, table.id));
    onClose();
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
        <button type="button" onClick={() => void deleteTable()} className={DANGER_BUTTON_XS}>
          <TrashIcon /> Delete table
        </button>
      </div>
    </aside>
  );
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A text field that commits on blur or Enter when its text changed, and reverts on Escape. */
function CommitInput({ value, onCommit, ariaLabel, className, autoFocus = false }: { value: string; onCommit: (value: string) => void; ariaLabel: string; className: string; autoFocus?: boolean }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.select();
    }
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      spellCheck={false}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      className={className}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onCommit(draft);
        }
      }}
      onKeyDown={(event) => commitKeys(event, () => setDraft(value))}
    />
  );
}

/** A two-line text field with the same commit rules as `CommitInput`; Shift+Enter inserts a line break. */
function CommitTextarea({ value, onCommit, placeholder }: { value: string; onCommit: (value: string) => void; placeholder: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      value={draft}
      rows={2}
      spellCheck={false}
      placeholder={placeholder}
      className={`${INPUT} h-auto resize-y py-1 leading-snug`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onCommit(draft);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.shiftKey) return;
        commitKeys(event, () => setDraft(value));
      }}
    />
  );
}

/** Enter commits by blurring the field, Escape reverts the draft and blurs; both stay inside the editor. */
function commitKeys(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, revert: () => void) {
  if (event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    revert();
    event.currentTarget.blur();
  }
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
