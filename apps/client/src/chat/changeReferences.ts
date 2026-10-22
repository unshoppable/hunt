/** A place in a file: its worktree-relative path and the 1-based, inclusive lines. */
export type FileLocation = { path: string; startLine: number; endLine: number };

/** Places shown below a reply; the agent lists the most important first. */
const MAX_REFERENCES = 4;

/**
 * `<!-- hunt:changes … -->` with one `path:line` or `path:start-end` per line, which the agent puts after the text of a
 * reply that changed files (see `prompts/change-references.system-prompt.md`).
 */
const MARKER = /^[ \t]*<!--\s*hunt:changes\b([\s\S]*?)-->[ \t]*$/m;
/** One place: the path, then the first and optionally the last line, each with an optional `L` prefix. */
const REFERENCE = /^(.+?):L?(\d+)(?:\s*[-–]\s*L?(\d+))?$/;

/** The changed places the agent marked in `reply`, at most four; absolute paths inside the worktree at `basePath` become relative. */
export function findChangeReferences(reply: string, basePath: string): FileLocation[] {
  const body = reply.match(MARKER)?.[1];
  if (!body) return [];
  const references = body.split("\n").flatMap((line) => parseFileLocation(line.trim().replace(/^[-*]\s+/, ""), basePath) ?? []);
  return references.slice(0, MAX_REFERENCES);
}

/**
 * The place `text` names as `path:line` or `path:start-end` (each line with an optional `L`, backticks ignored); null
 * when it names none or an absolute path outside the worktree at `basePath`. Absolute paths inside it become relative.
 */
export function parseFileLocation(text: string, basePath: string): FileLocation | null {
  const match = text.trim().replace(/`/g, "").match(REFERENCE);
  if (!match) return null;
  const path = worktreePath(match[1], basePath);
  const startLine = Number(match[2]);
  const endLine = Math.max(startLine, Number(match[3] ?? startLine));
  return path && startLine > 0 ? { path, startLine, endLine } : null;
}

/** The reply without the change marker. */
export function stripChangeMarker(reply: string): string {
  return reply.replace(MARKER, "");
}

/** `path` relative to the worktree at `basePath`; null for an absolute path outside it. */
function worktreePath(path: string, basePath: string): string | null {
  const relative = basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length + 1) : path.replace(/^\.\//, "");
  return relative.startsWith("/") ? null : relative;
}
