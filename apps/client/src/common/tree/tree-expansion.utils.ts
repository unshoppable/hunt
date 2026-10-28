import { isInsideFolder } from "../path/path.utils";

/**
 * Opens or closes `folder` (`""` is the root) in a set of open folders. Closing closes every folder below it too, so
 * reopening it shows its subfolders closed.
 */
export function toggleInExpanded(expanded: ReadonlySet<string>, folder: string): Set<string> {
  if (!expanded.has(folder)) return new Set(expanded).add(folder);
  return new Set([...expanded].filter((path) => path !== folder && !isInsideFolder(path, folder)));
}

/**
 * Opens or closes `folder` in a set of closed folders. Closing also closes every one of `folders` (all folder paths of
 * the tree) below it, so reopening it shows its subfolders closed.
 */
export function toggleInCollapsed(collapsed: ReadonlySet<string>, folder: string, folders: Iterable<string>): Set<string> {
  const next = new Set(collapsed);
  if (next.delete(folder)) return next;
  next.add(folder);
  for (const path of folders) {
    if (isInsideFolder(path, folder)) {
      next.add(path);
    }
  }
  return next;
}
