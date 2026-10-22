import type { ChangedFile } from "../ipc/types";
import { baseName } from "../ui/path";

export type FolderNode = {
  kind: "folder";
  /** Path segments joined with "/", e.g. `apps/backend/src`; the root has an empty path. */
  path: string;
  /** Display name; compacted chains show every merged segment, e.g. `src/app/user`. */
  name: string;
  children: TreeNode[];
  /** Every file below this folder, in display order. */
  files: ChangedFile[];
};

export type FileNode = { kind: "file"; file: ChangedFile; name: string };

export type TreeNode = FolderNode | FileNode;

type MutableFolder = { name: string; folders: Map<string, MutableFolder>; files: ChangedFile[] };

/**
 * Builds the folder tree of a changelist. Folders with a single subfolder and no files are merged
 * into one node (`apps/backend/src`), folders sort before files, both alphabetically.
 */
export function buildChangeTree(files: ChangedFile[]): FolderNode {
  const root: MutableFolder = { name: "", folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let child = folder.folders.get(segment);
      if (!child) {
        child = { name: segment, folders: new Map(), files: [] };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  return finalize(root, "");
}

/** The paths of every folder below `folder`, at any depth. */
export function folderPaths(folder: FolderNode): string[] {
  return folder.children.flatMap((child) => (child.kind === "folder" ? [child.path, ...folderPaths(child)] : []));
}

function finalize(folder: MutableFolder, path: string): FolderNode {
  let name = folder.name;
  let current = folder;
  let currentPath = path;
  while (current.files.length === 0 && current.folders.size === 1 && currentPath !== "") {
    const [only] = current.folders.values();
    name = `${name}/${only.name}`;
    currentPath = `${currentPath}/${only.name}`;
    current = only;
  }

  const folders = [...current.folders.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child) => finalize(child, currentPath ? `${currentPath}/${child.name}` : child.name));
  const fileNodes: FileNode[] = [...current.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ kind: "file", file, name: baseName(file.path) }));

  const children: TreeNode[] = [...folders, ...fileNodes];
  const allFiles = children.flatMap((child) => (child.kind === "folder" ? child.files : [child.file]));
  return { kind: "folder", path: currentPath, name, children, files: allFiles };
}
