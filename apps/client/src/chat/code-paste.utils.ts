/**
 * Code copied from Hunt's editors and pasted into the prompt goes in as a Markdown fence, and the chat shows the fences
 * of a sent prompt as code blocks. Monaco marks its copies with the `vscode-editor-data` clipboard type, which holds the
 * language of the copied code; other apps never write it.
 */

/** Clipboard type in which Monaco records the language of a copy. */
export const EDITOR_CLIPBOARD_TYPE = "vscode-editor-data";

/** One part of a prompt's text: plain text, or the code of a fence with its Monaco language id. */
export type PromptSegment = { kind: "text"; text: string } | { kind: "code"; text: string; language: string };

/** The Monaco language id that the `vscode-editor-data` value `raw` records, "" when it records none; null when `raw` is not Monaco's. */
export function editorCopyLanguage(raw: string): string | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || !data || (data as { version?: unknown }).version !== 1) return null;
    const mode = (data as { mode?: unknown }).mode;
    return typeof mode === "string" && mode !== "plaintext" ? mode : "";
  } catch {
    return null;
  }
}

/** `code` as a Markdown fence tagged with `language`; the fence is longer than any backtick run inside the code. */
export function fenceCode(code: string, language: string): string {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

/**
 * What to insert for `code` copied from an editor when the caret has `before` and `after` around it: the fenced code on
 * lines of its own, with the caret ending up on the line below. Null for a single line, which is pasted as it is.
 */
export function codePasteText(code: string, language: string, before: string, after: string): string | null {
  const trimmed = code.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (!trimmed.includes("\n")) return null;
  const lineBreakBefore = before && !before.endsWith("\n") ? "\n" : "";
  const lineBreakAfter = after.startsWith("\n") ? "" : "\n";
  return `${lineBreakBefore}${fenceCode(trimmed, language)}${lineBreakAfter}`;
}

const OPENING_FENCE = /^ {0,3}(`{3,})([^`]*)$/;

/** Splits `text` into plain text and fenced code; as in CommonMark, a fence without its closing line runs to the end. */
export function splitFencedCode(text: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  const lines = text.split("\n");
  let plain: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = lines[index].match(OPENING_FENCE);
    if (!opening) {
      plain.push(lines[index]);
      index++;
      continue;
    }
    const closing = new RegExp(`^ {0,3}\`{${opening[1].length},}\\s*$`);
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end])) {
      end++;
    }
    if (plain.length) {
      segments.push({ kind: "text", text: plain.join("\n") });
      plain = [];
    }
    segments.push({ kind: "code", text: lines.slice(index + 1, end).join("\n"), language: opening[2].trim() });
    index = end + 1;
  }
  if (plain.length) {
    segments.push({ kind: "text", text: plain.join("\n") });
  }
  return segments;
}
