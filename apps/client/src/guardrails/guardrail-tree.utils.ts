import { dirName, isInsideFolder } from "../common/path/path.utils";
import type { Guardrail, GuardrailKind, GuardrailListing, GuardrailListRow, GuardrailLocation, TreeDirKind, TreeRow } from "./guardrail.types";
import { INSTRUCTION_FILE, isInstructionFile } from "./guardrail-paths.utils";

/** The folder of a worktree-relative path, `""` for a file at the root. */
export function folderOf(path: string): string {
  return dirName(path);
}

/** Every folder (and folder of a folder) of the given files, sorted; the root itself is left out. */
export function foldersOf(files: string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    for (let folder = folderOf(file); folder; folder = folderOf(folder)) {
      folders.add(folder);
    }
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}

/**
 * The directories of the kind whose configured directory is `directory`: that one at the root, which is always read,
 * and each of `folders` that ends in it (`src/api/.claude/rules`), as the project files reveal them.
 */
export function directoriesOfKind(directory: string, folders: readonly string[]): string[] {
  return [directory, ...folders.filter((folder) => folder.endsWith(`/${directory}`))];
}

/** The instruction files among `files`, shallow ones first so that the root CLAUDE.md leads the list, then by path. */
export function instructionGuardrails(files: readonly string[]): Guardrail[] {
  const instructions: Guardrail[] = files.filter(isInstructionFile).map((path) => ({ kind: "instruction", path, name: INSTRUCTION_FILE, folder: folderOf(path) }));
  return instructions.sort((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path));
}

/** The folder row of the tree an entry is listed under: its own folder; for a skill the folder holding the skill folders. */
export function treeParentOf(entry: Guardrail): string {
  return entry.kind === "skill" ? folderOf(folderOf(entry.path)) : folderOf(entry.path);
}

/** Whether `folder` is `directory` itself or lies below it. */
function isAtOrBelow(folder: string, directory: string): boolean {
  return folder === directory || isInsideFolder(folder, directory);
}

/**
 * The folder (`""` for the root) whose `.claude` holds `directory`, which is `kindDir` (the configured `.claude/rules`)
 * at the root or below a folder; null when `directory` is not such a directory.
 */
export function ownerFolderOf(directory: string, kindDir: string): string | null {
  if (directory === kindDir) return "";
  return directory.endsWith(`/${kindDir}`) ? directory.slice(0, -kindDir.length - 1) : null;
}

/**
 * The folder whose kind directory `folder` is on the way to, when `folder` is a container of the kind directory
 * `kindDir` (`.claude` or `src/api/.claude` for `.claude/rules`): `""` for the root, null when it is no container.
 */
function containerOwnerOf(folder: string, kindDir: string): string | null {
  const segments = kindDir.split("/");
  for (let count = segments.length - 1; count > 0; count--) {
    const prefix = segments.slice(0, count).join("/");
    if (folder === prefix) return "";
    if (folder.endsWith(`/${prefix}`)) return folder.slice(0, -prefix.length - 1);
  }
  return null;
}

/** The kind directory `kindDir` of `owner` (`""` for the root). */
function kindDirOf(owner: string, kindDir: string): string {
  return owner ? `${owner}/${kindDir}` : kindDir;
}

/**
 * Where the "+" of the tree folder `folder` creates a file of `kind`: inside the kind's directory the folder is or
 * lies in, in the directory a container (`.claude`) leads to, otherwise in a new `<folder>/<kind dir>` (which
 * Claude Code loads once it works in that folder).
 */
export function newGuardrailLocation(kind: TreeDirKind, folder: string, listing: GuardrailListing): GuardrailLocation {
  const directory = listing.foundDirs[kind].find((candidate) => isAtOrBelow(folder, candidate));
  if (directory) return { dir: directory, folder: folder === directory ? "" : folder.slice(directory.length + 1) };
  const owner = containerOwnerOf(folder, listing.dirs[kind]) ?? folder;
  return { dir: kindDirOf(owner, listing.dirs[kind]), folder: "" };
}

/**
 * The folders of the tree of `kind`: the worktree's folders and every folder on the way to one of the kind's
 * directories (so that a git-ignored `.claude` still shows). A container (`.claude`) shows only when it holds one
 * of the kind's directories, and inside it only that directory; the folders of a skill are left out since the
 * skill itself is the entry.
 */
export function treeFolders(kind: GuardrailKind, listing: GuardrailListing): string[] {
  const folders = new Set(listing.folders);
  if (kind !== "rule" && kind !== "skill") return [...folders];
  const kindDir = listing.dirs[kind];
  const directories = listing.foundDirs[kind];
  for (const directory of directories) {
    for (let folder = directory; folder; folder = folderOf(folder)) {
      folders.add(folder);
    }
  }
  const isHidden = (folder: string) => {
    if (kind === "skill" && directories.some((directory) => isInsideFolder(folder, directory))) return true;
    for (let candidate = folder; candidate; candidate = folderOf(candidate)) {
      const owner = containerOwnerOf(candidate, kindDir);
      if (owner === null) continue;
      const own = kindDirOf(owner, kindDir);
      return !directories.includes(own) || (candidate !== folder && !isAtOrBelow(folder, own));
    }
    return false;
  };
  return [...folders].filter((folder) => !isHidden(folder)).sort((left, right) => left.localeCompare(right));
}

/** The folders a tree starts out open: the root and every folder on the way to an entry or to one of `directories`, those included. */
export function expandedForTree(entries: Guardrail[], directories: string[] = []): Set<string> {
  const expanded = new Set([""]);
  for (const start of [...entries.map(treeParentOf), ...directories]) {
    for (let folder = start; folder; folder = folderOf(folder)) {
      expanded.add(folder);
    }
  }
  return expanded;
}

/**
 * The rows of a tree: the root (shown as `projectName`), then below each open folder its subfolders by name and,
 * last, the entries listed under it (see `treeParentOf`). A closed folder hides everything below it; a folder row
 * tells whether entries lie anywhere below it, so that empty branches can be set off.
 */
export function guardrailTreeRows(folders: string[], entries: Guardrail[], expanded: ReadonlySet<string>, projectName: string): TreeRow[] {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    const parent = folderOf(folder);
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const byFolder = new Map<string, Guardrail[]>();
  const holding = new Set<string>();
  for (const entry of entries) {
    const parent = treeParentOf(entry);
    byFolder.set(parent, [...(byFolder.get(parent) ?? []), entry]);
    for (let folder = parent; folder; folder = folderOf(folder)) {
      holding.add(folder);
    }
  }

  const rows: TreeRow[] = [];
  const walk = (folder: string, name: string, depth: number) => {
    rows.push({ type: "folder", path: folder, name, depth, hasEntry: byFolder.has(folder), holdsEntries: !folder || holding.has(folder) });
    if (!expanded.has(folder)) return;
    for (const child of children.get(folder) ?? []) {
      walk(child, child.slice(folder ? folder.length + 1 : 0), depth + 1);
    }
    for (const entry of byFolder.get(folder) ?? []) {
      rows.push({ type: "file", entry, depth: depth + 1 });
    }
  };
  walk("", projectName, 0);
  return rows;
}

/**
 * The rows of the list: entries grouped under their folders, folders sorted by name and placed before the loose
 * entries of their level (which keep their order); the rows below a folder in `collapsed` are left out.
 */
export function guardrailListRows(entries: Guardrail[], collapsed: ReadonlySet<string> = new Set()): GuardrailListRow[] {
  type Node = { folders: Map<string, Node>; entries: Guardrail[] };
  const root: Node = { folders: new Map(), entries: [] };
  const nodeOf = (folder: string): Node => {
    let node = root;
    for (const segment of folder ? folder.split("/") : []) {
      let child = node.folders.get(segment);
      if (!child) {
        child = { folders: new Map(), entries: [] };
        node.folders.set(segment, child);
      }
      node = child;
    }
    return node;
  };
  for (const entry of entries) {
    nodeOf(entry.folder).entries.push(entry);
  }

  const rows: GuardrailListRow[] = [];
  const walk = (node: Node, folder: string, depth: number) => {
    const names = [...node.folders.keys()].sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const path = folder ? `${folder}/${name}` : name;
      rows.push({ type: "folder", folder: path, name, depth });
      if (!collapsed.has(path)) {
        walk(node.folders.get(name)!, path, depth + 1);
      }
    }
    for (const entry of node.entries) {
      rows.push({ type: "entry", entry, depth });
    }
  };
  walk(root, "", 0);
  return rows;
}
