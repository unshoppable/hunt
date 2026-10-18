/** Worktree-relative paths as the sync helper handles them: `/`-separated, the worktree itself is the empty string. */

/** The folder that holds `path`; "" for a path at the top of the worktree. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** The last segment of `path`. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `name` inside `folder`. */
export function childOf(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** Whether `path` is `folder` or lies below it; everything lies below "". */
export function isAtOrBelow(path: string, folder: string): boolean {
  return !folder || path === folder || path.startsWith(`${folder}/`);
}

/** The folders that hold `path`, deepest first, without the worktree itself. */
export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  for (let folder = parentOf(path); folder; folder = parentOf(folder)) {
    ancestors.push(folder);
  }
  return ancestors;
}

/** The worktree ("") and every folder that holds or leads to one of `paths`. */
export function foldersOf(paths: Iterable<string>): Set<string> {
  const folders = new Set([""]);
  for (const path of paths) {
    for (const folder of ancestorsOf(path)) {
      if (folders.has(folder)) break;
      folders.add(folder);
    }
  }
  return folders;
}

/** Whether the helper leaves `path` alone: Git's own folder and Hunt's `.hunt` folder at the top of the worktree. */
export function isSkipped(path: string): boolean {
  const first = path.split("/", 1)[0];
  return first === ".git" || first === ".hunt";
}

/** Whether a change of `path` changes Git's ignore rules of the worktree (any `.gitignore`). */
export function isIgnoreFile(path: string): boolean {
  return nameOf(path) === ".gitignore";
}

/** The entries of Git's `-z` output. */
export function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}
