import { DIAGRAM_FILE_SUFFIX } from "../common/diagram/diagram-file.utils";

/**
 * The segments of a worktree-relative folder pattern such as `DEFAULT_DIAGRAM_SAVE_DIR`, or null when the pattern is
 * empty, absolute or climbs out of the worktree. A `*` segment stands for every subfolder at that place.
 */
export function savePatternSegments(pattern: string): string[] | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return null;
  const segments = trimmed.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments;
}

/**
 * The folders `pattern` names, sorted: each `*` segment expands to the visible subfolders `listFolders` reports for
 * the path so far (none when that path does not exist), every other segment is taken as it is, also when the folder
 * does not exist yet. An invalid pattern yields no folder.
 */
export async function expandSaveFolders(pattern: string, listFolders: (path: string) => Promise<string[]>): Promise<string[]> {
  const segments = savePatternSegments(pattern);
  if (!segments) return [];
  let prefixes = [""];
  for (const segment of segments) {
    if (segment !== "*") {
      prefixes = prefixes.map((prefix) => (prefix ? `${prefix}/${segment}` : segment));
      continue;
    }
    const expanded = await Promise.all(
      prefixes.map(async (prefix) => {
        const names = await listFolders(prefix).catch(() => []);
        return names.filter((name) => !name.startsWith(".")).map((name) => (prefix ? `${prefix}/${name}` : name));
      }),
    );
    prefixes = expanded.flat();
  }
  return [...new Set(prefixes)].sort();
}

/** Kebab-case file name stem from free text: lowercase letters, digits and dashes only; empty when nothing is left. */
export function diagramFileStem(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The name a saved diagram starts with in the save dialog: its title in kebab case, else its type. */
export function defaultDiagramName(diagram: { type: string; title?: string }): string {
  return diagramFileStem(diagram.title ?? "") || diagram.type;
}

/** Worktree-relative path of the diagram file `name` in `folder`; the suffix is added unless `name` has it already. */
export function diagramFilePath(folder: string, name: string): string {
  const stem = diagramFileStem(name.endsWith(DIAGRAM_FILE_SUFFIX) ? name.slice(0, -DIAGRAM_FILE_SUFFIX.length) : name);
  return `${folder.replace(/\/+$/, "")}/${stem}${DIAGRAM_FILE_SUFFIX}`;
}
