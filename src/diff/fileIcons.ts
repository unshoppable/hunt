import { useMemo } from "react";
import { useSettingsStore, type IconRule } from "../state/settings";
import associations from "./catppuccinIcons/associations.json";
import { matchesGlob } from "./glob";
import { baseName } from "../ui/path";

const svgs = import.meta.glob("./catppuccinIcons/icons/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Maps icon names (e.g. "typescript", "folder_src_open") to their bundled URLs. */
const urlByIcon = new Map<string, string>();
for (const [path, url] of Object.entries(svgs)) {
  urlByIcon.set(path.slice(path.lastIndexOf("/") + 1, -".svg".length), url);
}

/** Every vendored icon name, sorted; the icon rule picker lists them. */
export const ICON_NAMES: readonly string[] = [...urlByIcon.keys()].sort();

function urlOf(icon: string): string {
  const url = urlByIcon.get(icon);
  if (!url) throw new Error(`Catppuccin icon ${icon} is not vendored; run tools/icons/syncCatppuccinIcons.mjs`);
  return url;
}

/** URL of a vendored icon by name, or null for a name that is not shipped. */
export function iconUrl(icon: string): string | null {
  return urlByIcon.get(icon) ?? null;
}

/**
 * Icon name for a file name, resolved like a VS Code icon theme: the lowercased full name first, then every
 * extension chain from the longest ("module.ts") to the shortest ("ts"), then the generic file icon.
 */
function iconByName(fileName: string): string {
  const lower = fileName.toLowerCase();
  const byName = (associations.fileNames as Record<string, string>)[lower];
  if (byName) return byName;
  const parts = lower.split(".");
  for (let index = 1; index < parts.length; index++) {
    const byExtension = (associations.fileExtensions as Record<string, string>)[parts.slice(index).join(".")];
    if (byExtension) return byExtension;
  }
  return "_file";
}

/**
 * Icon name for a worktree-relative file path: the first rule whose glob matches the path and that names a shipped
 * icon wins; otherwise the file name decides (see iconByName).
 */
export function resolveFileIcon(path: string, rules: readonly IconRule[]): string {
  for (const rule of rules) {
    if (urlByIcon.has(rule.icon) && matchesGlob(rule.glob, path)) return rule.icon;
  }
  return iconByName(baseName(path));
}

/**
 * Resolver from a worktree-relative file path (a bare file name works too) to its icon URL, bound to the icon rules
 * of the settings; the component re-renders when the rules change.
 */
export function useFileIconUrl(): (path: string) => string {
  const rules = useSettingsStore((state) => state.iconRules);
  return useMemo(() => {
    const cache = new Map<string, string>();
    return (path: string) => {
      const cached = cache.get(path);
      if (cached) return cached;
      const url = urlOf(resolveFileIcon(path, rules));
      cache.set(path, url);
      return url;
    };
  }, [rules]);
}

/** Icon URL for a worktree-relative file path under the current icon rules, outside of rendering (see useFileIconUrl). */
export function fileIconUrl(path: string): string {
  return urlOf(resolveFileIcon(path, useSettingsStore.getState().iconRules));
}

/** URL of the Catppuccin icon for a directory name, in its open state if `isOpen`; falls back to the generic folder icon. */
export function folderIconUrl(folderName: string, isOpen = false): string {
  const icon = (associations.folderNames as Record<string, string>)[folderName.toLowerCase()] ?? "_folder";
  return urlOf(isOpen ? `${icon}_open` : icon);
}

/** URL of the project root icon, in its open state if `isOpen`. */
export function rootFolderIconUrl(isOpen = false): string {
  return urlOf(isOpen ? "_root_open" : "_root");
}
