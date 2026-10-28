import type { Layout } from "react-resizable-panels";

/** Remembered sizes of a group's panes in pixels, by pane id. The group's fill pane has none: it takes what the others leave. */
export type PaneSizes = Record<string, number>;

/**
 * localStorage key of the remembered pane sizes, one entry per group id. Every window reads and writes the same
 * entries, so a group looks the same in each window and after a restart.
 */
const STORAGE_KEY = "hunt-pane-sizes";

/** Key of the percentage layout `useDefaultLayout` of react-resizable-panels stored for a group before it stored pixels. */
function legacyKey(groupId: string): string {
  return `react-resizable-panels:${groupId}`;
}

function isSizeMap(value: unknown): value is Record<string, number> {
  return !!value && typeof value === "object" && Object.values(value).every((size) => typeof size === "number" && Number.isFinite(size));
}

function readStoredGroups(): Record<string, PaneSizes> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!stored || typeof stored !== "object") return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, PaneSizes] => isSizeMap(entry[1])));
  } catch {
    return {};
  }
}

/** The pixel sizes remembered for `groupId`, or null when its panes were never resized. */
export function readPaneSizes(groupId: string): PaneSizes | null {
  return readStoredGroups()[groupId] ?? null;
}

/** Remembers `sizes` for `groupId` and drops the group's percentage layout from before. */
export function writePaneSizes(groupId: string, sizes: PaneSizes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStoredGroups(), [groupId]: sizes }));
    localStorage.removeItem(legacyKey(groupId));
  } catch {
    // Storage may be unavailable; the panes then simply open with their default sizes next time.
  }
}

/** The percentage layout stored for `groupId` before pane sizes were pixels, shown until its panes are resized again. */
export function readLegacyLayout(groupId: string): Layout | undefined {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(legacyKey(groupId)) ?? "null");
    return isSizeMap(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The layout that gives each of `paneIds` but `fillPane` its remembered size out of `paneSpace` pixels, the fill pane
 * taking the rest. When they do not fit, the layout leaves the fill pane less than nothing and the group's validation
 * shrinks the first panes towards their minimum. Null when the group has no space yet or `sizes` lacks one of the panes.
 */
export function layoutFromPixels(sizes: PaneSizes, paneIds: readonly string[], fillPane: string, paneSpace: number): Layout | null {
  if (paneSpace <= 0 || !paneIds.includes(fillPane)) return null;
  const layout: Layout = {};
  let fixedShare = 0;
  for (const paneId of paneIds) {
    if (paneId === fillPane) continue;
    const size = sizes[paneId];
    if (size === undefined) return null;
    layout[paneId] = (size / paneSpace) * 100;
    fixedShare += layout[paneId];
  }
  layout[fillPane] = 100 - fixedShare;
  return layout;
}

/** The pixel sizes of every pane of `layout` but `fillPane`, out of `paneSpace` pixels. */
export function pixelsFromLayout(layout: Layout, fillPane: string, paneSpace: number): PaneSizes {
  return Object.fromEntries(
    Object.entries(layout)
      .filter(([paneId]) => paneId !== fillPane)
      .map(([paneId, share]) => [paneId, Math.round((share / 100) * paneSpace)]),
  );
}
