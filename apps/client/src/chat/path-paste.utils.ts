/**
 * A pasted path of an image file on this Mac is attached as an image instead of going in as text: an agent on a remote
 * VM cannot read the path, and the paste then behaves like a drop of the file.
 */

const FILE_URL_PREFIX = "file://";

/**
 * The absolute paths `text` consists of, one per line, or none when any line is something else. A line may be a
 * `file://` URL, wrapped in quotes, or escaped with backslashes as a terminal writes a dragged file.
 */
export function pastedPaths(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const paths = lines.map(pastedPath);
  return paths.every((path) => path !== null) ? paths : [];
}

/** The absolute path `line` names, or null when it names none. */
function pastedPath(line: string): string | null {
  if (line.startsWith(FILE_URL_PREFIX)) return fileUrlPath(line);
  const quoted = line.match(/^(['"])(.*)\1$/);
  const path = quoted ? quoted[2] : line.replace(/\\(.)/g, "$1");
  return path.startsWith("/") ? path : null;
}

/** The path of the local `file://` URL `url`, or null when it names another host or is malformed. */
function fileUrlPath(url: string): string | null {
  const rest = url.slice(FILE_URL_PREFIX.length);
  const path = rest.startsWith("localhost/") ? rest.slice("localhost".length) : rest;
  if (!path.startsWith("/")) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}
