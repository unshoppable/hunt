/**
 * Several selected rows of a tree, as in WebStorm: a click selects one row, ⇧-click every visible row from the anchor
 * to the clicked one, ⌘-click adds or removes one row. `lead` is the keyboard cursor, `anchor` the row a ⇧-click range
 * starts from. `keys` may still hold rows a collapsed folder hides, so read it through `visibleSelection`.
 */
export type TreeSelection = { lead: string; anchor: string; keys: readonly string[] };

export function singleSelection(key: string): TreeSelection {
  return { lead: key, anchor: key, keys: [key] };
}

/** ⇧-click on `key`: the visible rows from the anchor to `key`, which becomes the lead; `key` alone when the anchor is hidden. */
export function extendSelection(selection: TreeSelection | null, rowKeys: readonly string[], key: string): TreeSelection {
  if (!selection) return singleSelection(key);
  const anchorIndex = rowKeys.indexOf(selection.anchor);
  const keyIndex = rowKeys.indexOf(key);
  if (anchorIndex === -1 || keyIndex === -1) return singleSelection(key);
  return { lead: key, anchor: selection.anchor, keys: rowKeys.slice(Math.min(anchorIndex, keyIndex), Math.max(anchorIndex, keyIndex) + 1) };
}

/** ⌘-click on `key`: adds the row or removes it; either way it becomes the lead and the anchor of the next ⇧-click. */
export function toggleInSelection(selection: TreeSelection | null, key: string): TreeSelection {
  if (!selection) return singleSelection(key);
  const keys = selection.keys.includes(key) ? selection.keys.filter((selectedKey) => selectedKey !== key) : [...selection.keys, key];
  return { lead: key, anchor: key, keys };
}

/** The selected rows that are visible, in display order. */
export function visibleSelection(selection: TreeSelection | null, rowKeys: readonly string[]): string[] {
  if (!selection) return [];
  const selectedKeys = new Set(selection.keys);
  return rowKeys.filter((key) => selectedKeys.has(key));
}
