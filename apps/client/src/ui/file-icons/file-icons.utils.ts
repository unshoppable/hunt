import { useSettingsStore, type FolderIconRule, type IconRule } from "../../settings/settings.store";
import associations from "./atom-icons/associations.json";
import { matchesGlob } from "../../common/glob/glob.utils";
import { baseName } from "../../common/path/path.utils";

const svgs = import.meta.glob("./atom-icons/icons/*.svg", {
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

/** The closed folder icons that ship an open state, sorted; the folder icon rule picker lists them. */
export const FOLDER_ICON_NAMES: readonly string[] = ICON_NAMES.filter((icon) => icon.startsWith("folder_") && urlByIcon.has(`${icon}_open`));
const folderIcons = new Set(FOLDER_ICON_NAMES);

/** URL of a vendored icon by name; throws for a name that is not shipped. */
export function vendoredIconUrl(icon: string): string {
  const url = urlByIcon.get(icon);
  if (!url) throw new Error(`Atom icon ${icon} is not vendored; run tools/icons/syncAtomIcons.mjs`);
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

/** Icon URL for a worktree-relative file path under the current icon rules, outside of rendering (see useFileIconUrl). */
export function fileIconUrl(path: string): string {
  return vendoredIconUrl(resolveFileIcon(path, useSettingsStore.getState().iconRules));
}

/**
 * Closed-state icon name for a worktree-relative folder path: the first rule that names a shipped folder icon and whose
 * glob matches the path, or with `includeSubfolders` the path of a folder above it, wins; otherwise the folder name
 * decides, falling back to the generic folder icon.
 */
export function resolveFolderIcon(path: string, rules: readonly FolderIconRule[]): string {
  const segments = path.split("/").filter(Boolean);
  const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  for (const rule of rules) {
    if (!folderIcons.has(rule.icon)) continue;
    if (matchesGlob(rule.glob, path)) return rule.icon;
    if (rule.includeSubfolders && ancestors.some((ancestor) => matchesGlob(rule.glob, ancestor))) return rule.icon;
  }
  return (associations.folderNames as Record<string, string>)[baseName(path).toLowerCase()] ?? "_folder";
}

/** URL of the folder icon `icon` in its open state if `isOpen`, else closed. */
export function folderIconStateUrl(icon: string, isOpen: boolean): string {
  return vendoredIconUrl(isOpen ? `${icon}_open` : icon);
}

/** Icon URL for a worktree-relative folder path under the current folder icon rules, outside of rendering (see useFolderIconUrl). */
export function folderIconUrl(path: string, isOpen = false): string {
  return folderIconStateUrl(resolveFolderIcon(path, useSettingsStore.getState().folderIconRules), isOpen);
}

/** URL of the project root icon, in its open state if `isOpen`. */
export function rootFolderIconUrl(isOpen = false): string {
  return vendoredIconUrl(isOpen ? "_root_open" : "_root");
}
