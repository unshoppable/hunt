import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { ShapeNode } from "./shape-diagram.types";
import type { TreeNavRow } from "../../common/tree/tree-navigation.utils";
import { Checkbox, type CheckState } from "../../ui/Checkbox";
import { ResizeGrips } from "../../ui/ResizeGrips";
import { useDismiss } from "../../ui/dismiss.hook";
import { usePopupSize } from "../../ui/popup-size.hook";
import { useTreeNavigation } from "../../ui/tree-navigation.hook";
import { useViewportSize } from "../../ui/viewport-size.hook";

const MIN_SIZE = { width: 200, height: 120 };
/** The largest share of the window's width and height the popover may take. */
const MAX_SHARE = 0.8;

/**
 * Popover below the ERD's "Tables" button, the counterpart of the dependency graph's `FileFilterPopover`: the tables
 * by name with a checkbox each. Every table starts checked; unchecking hides it and its relationships from the canvas,
 * the checkbox in the header toggles all of them. The list takes the focus: the arrow keys move through the rows, Space
 * or Enter toggles the row's checkbox. Closes on Escape or a click outside; a press on the button that opened it
 * (`anchorRef`) closes without reopening. It is as tall as its rows up to the remembered height; dragging its right or
 * bottom edge resizes it.
 */
export function TableFilterPopover({
  tables,
  hidden,
  onChange,
  onClose,
  anchorRef,
}: {
  tables: ShapeNode[];
  /** Ids of the unchecked tables. */
  hidden: ReadonlySet<string>;
  onChange: (hidden: Set<string>) => void;
  onClose: () => void;
  /** The "Tables" button the popover hangs below. */
  anchorRef: RefObject<HTMLButtonElement | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewport = useViewportSize();
  const { size, isHeightSet, grips } = usePopupSize("tableFilter", { min: MIN_SIZE, max: { width: viewport.width * MAX_SHARE, height: viewport.height * MAX_SHARE } });
  const sorted = useMemo(() => [...tables].sort((a, b) => a.label.localeCompare(b.label)), [tables]);

  useDismiss(rootRef, onClose, { anchorRefs: [anchorRef] });

  const shownCount = tables.filter((table) => !hidden.has(table.id)).length;
  const allState: CheckState = shownCount === 0 ? "unchecked" : shownCount === tables.length ? "checked" : "mixed";

  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next);
  };

  const toggleAll = () => onChange(allState === "checked" ? new Set(tables.map((table) => table.id)) : new Set());

  const navRows = useMemo<TreeNavRow[]>(() => sorted.map((table) => ({ key: table.id, depth: 0 })), [sorted]);
  const nav = useTreeNavigation({ rows: navRows, onToggle: () => {}, onActivate: toggle, onCheck: toggle });
  const { listRef } = nav;

  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, [listRef]);

  return (
    <div
      ref={rootRef}
      className="absolute top-full left-0 z-20 mt-1 flex flex-col rounded-md border border-neutral-600 bg-(--surface-inset) text-[13px] shadow-lg"
      style={{ width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined }}
    >
      <div className="flex items-center gap-2 border-b border-(--line) px-2 py-2 text-neutral-400">
        <Checkbox state={allState} onChange={toggleAll} title="Show all tables" />
        <span>
          {shownCount} of {tables.length} shown
        </span>
      </div>
      <ul {...nav.listProps} className="min-h-0 flex-1 overflow-y-auto p-1 leading-6 outline-none">
        {sorted.map((table) => (
          <li
            key={table.id}
            data-tree-key={table.id}
            className={`flex items-center gap-1.5 rounded px-2 ${nav.cursor === table.id ? "bg-(--row-selected)" : "hover:bg-(--row-hover)"}`}
          >
            <Checkbox state={hidden.has(table.id) ? "unchecked" : "checked"} onChange={() => toggle(table.id)} />
            <label
              className="min-w-0 flex-1 truncate text-neutral-200 uppercase"
              title={table.description ? `${table.label}: ${table.description}` : table.label}
              onClick={() => {
                toggle(table.id);
                nav.select(table.id);
              }}
            >
              {table.label}
            </label>
          </li>
        ))}
      </ul>
      <ResizeGrips edges={{ right: true, bottom: true }} {...grips} />
    </div>
  );
}
