/** The last segment of a slash-separated path (`src/a/b.ts` → `b.ts`); the path itself when it has no slash. */
export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** The path without its last segment (`src/a/b.ts` → `src/a`); the empty string when it has no slash. */
export function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * The name of a repository from its path: the last non-empty segment, so a trailing slash does not matter
 * (`/Users/me/dev/hunt/` → `hunt`); the path itself when it has no segment.
 */
export function repoName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Whether `path` lies below `folder` (`""` is the root, which holds everything). */
export function isInsideFolder(path: string, folder: string): boolean {
  return !folder || path.startsWith(`${folder}/`);
}

/** The paths that lie inside none of the others, in their order; deleting these deletes all of `paths`. */
export function outermostPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && isInsideFolder(path, other)));
}

/** The parent directory and the name of a path in one go. */
export function splitPath(path: string): { dir: string; name: string } {
  return { dir: dirName(path), name: baseName(path) };
}
