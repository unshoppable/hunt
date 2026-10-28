/** A hunk header with line numbers, `@@ -12,7 +12,9 @@`. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
/** First character of a line in a hunk: context, addition, removal or `\ No newline at end of file`. */
const LINE_PREFIX = /^[ +\-\\]/;

/**
 * The text a ```diff fence replaces in its file: the context and removed lines without their prefix; `@@` headers and
 * additions left out. Locates the fence in the file like the excerpt of a code block (see code-excerpt.utils.ts).
 */
export function diffFenceOldText(body: string): string {
  return hunkLines(body)
    .filter((line) => !HUNK_HEADER.test(line) && !line.startsWith("+") && !line.startsWith("\\"))
    .map((line) => line.slice(1))
    .join("\n");
}

/**
 * A ```diff fence as the unified-diff patch of `path` that git-diff-view renders. Hunks with numbered `@@` headers keep
 * their numbers; lines without one become a single hunk whose first line is `startLine` of the file. Every line ends
 * with a newline, as git-diff-view compares it with the side it composes. Null while the fence adds or removes no line,
 * which git-diff-view would render empty.
 */
export function diffFencePatch(body: string, path: string, startLine: number): string | null {
  const lines = hunkLines(body);
  if (!lines.some((line) => line.startsWith("+") || line.startsWith("-"))) return null;
  const fileHeader = `--- a/${path}\n+++ b/${path}`;
  if (lines.some((line) => HUNK_HEADER.test(line))) return `${[fileHeader, ...lines].join("\n")}\n`;
  const oldCount = lines.filter((line) => !line.startsWith("+") && !line.startsWith("\\")).length;
  const newCount = lines.filter((line) => !line.startsWith("-") && !line.startsWith("\\")).length;
  // A side without lines starts at the line before the change, as in git's own patches.
  const hunkHeader = `@@ -${oldCount ? startLine : startLine - 1},${oldCount} +${newCount ? startLine : startLine - 1},${newCount} @@`;
  return `${[fileHeader, hunkHeader, ...lines].join("\n")}\n`;
}

/**
 * The lines of a ```diff fence after a leading file header (`--- a/…` and `+++ b/…`, with `diff --git` and `index` lines
 * before them); a line without a prefix counts as context.
 */
function hunkLines(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const headerEnd = lines.findIndex((line, index) => line.startsWith("+++ ") && lines[index - 1]?.startsWith("--- "));
  const isFileHeader = headerEnd > 0 && lines.slice(0, headerEnd - 1).every((line) => !LINE_PREFIX.test(line) && !line.startsWith("@@"));
  return (isFileHeader ? lines.slice(headerEnd + 1) : lines).map((line) => (LINE_PREFIX.test(line) || HUNK_HEADER.test(line) ? line : ` ${line}`));
}
