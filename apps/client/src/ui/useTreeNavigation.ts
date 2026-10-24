import { useRef, useState, type KeyboardEvent } from "react";
import { treeKeyAction, type TreeNavAction, type TreeNavRow } from "./treeNavigation";

/**
 * Keyboard navigation of a tree (keys in `treeKeyAction`). The cursor is the owner's selection (`selectedKey`) or,
 * after a move onto a row the owner cannot select (a folder, see `isSelectable`), that row until the selection
 * changes. Spread `listProps` on the scroll container, give every row `data-tree-key`, and route row clicks through
 * `select` so that mouse and keys share one cursor.
 */
export function useTreeNavigation<Container extends HTMLElement = HTMLUListElement>({
  rows,
  selectedKey = null,
  onSelect,
  isSelectable = () => true,
  onToggle,
  onActivate,
  onCheck,
  revealKey,
}: {
  rows: readonly TreeNavRow[];
  /** The row the owner shows as selected (the file whose diff is open, the branch the log is filtered on). */
  selectedKey?: string | null;
  /** Makes a row the owner's selection; rows `isSelectable` rejects only take the cursor. */
  onSelect?: (key: string) => void;
  isSelectable?: (key: string) => boolean;
  onToggle: (key: string) => void;
  /** Enter on a row without children. */
  onActivate?: (key: string) => void;
  /** Space on a row. */
  onCheck?: (key: string) => void;
  /** Scrolls the row into view; needed by a virtualized list, whose rows off screen have no element to scroll to. */
  revealKey?: (key: string) => void;
}) {
  const listRef = useRef<Container>(null);
  const [rowCursor, setRowCursor] = useState<{ key: string; selectedKey: string | null } | null>(null);
  const cursor = rowCursor && rowCursor.selectedKey === selectedKey ? rowCursor.key : selectedKey;

  const select = (key: string) => {
    if (!onSelect || !isSelectable(key)) {
      setRowCursor({ key, selectedKey });
      return;
    }
    setRowCursor(null);
    if (key !== selectedKey) {
      onSelect(key);
    }
  };

  /** Moves the cursor by key, scrolls the row into view and keeps the focus on the list rather than on a row's button. */
  const moveTo = (key: string) => {
    if (key !== cursor) {
      select(key);
    }
    const list = listRef.current;
    if (revealKey) {
      revealKey(key);
    } else {
      list?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
    }
    list?.focus({ preventScroll: true });
  };

  /** Runs the action; false when the tree has no handler for it, so the key keeps its default. */
  const run = (action: TreeNavAction): boolean => {
    switch (action.type) {
      case "move":
        moveTo(action.key);
        return true;
      case "toggle":
        onToggle(action.key);
        return true;
      case "activate":
        onActivate?.(action.key);
        return !!onActivate;
      case "check":
        onCheck?.(action.key);
        return !!onCheck;
    }
  };

  const onKeyDown = (event: KeyboardEvent<Container>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || handlesOwnKey(event.target, event.key)) return;
    const action = treeKeyAction(rows, cursor, event.key);
    if (!action || !run(action)) return;
    event.preventDefault();
  };

  return { cursor, select, listRef, listProps: { ref: listRef, tabIndex: 0, onKeyDown } };
}

/** Whether the focused element inside the tree handles the key itself: a text field every key, a checkbox Space. */
function handlesOwnKey(target: EventTarget, key: string): boolean {
  if (target instanceof HTMLInputElement) return target.type !== "checkbox" || key === " ";
  return target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}
