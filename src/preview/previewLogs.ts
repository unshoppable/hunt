import type { PreviewLogChunk } from "../ipc/types";

/** The part of a preview log the panel shows: its text and the byte offset in the log where the next chunk starts. */
export type LogView = { text: string; end: number };

export const EMPTY_LOG: LogView = { text: "", end: 0 };

/** Lines the panel keeps of a log; older ones are dropped. */
export const MAX_LOG_LINES = 5000;

// Terminal escape sequences (colors, cursor moves) and other control characters except tab and newline.
const ANSI_ESCAPE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]`, "g");

/** `text` without terminal escape sequences and control characters; carriage returns end a line. */
export function stripAnsi(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(ANSI_ESCAPE, "");
}

/**
 * `view` with `chunk` appended: a chunk that starts elsewhere than where the view ends (a rotation, or the first read
 * of the log's tail) replaces the text. At most `maxLines` lines are kept.
 */
export function appendLogChunk(view: LogView, chunk: PreviewLogChunk, maxLines = MAX_LOG_LINES): LogView {
  const text = chunk.reset || chunk.offset !== view.end ? stripAnsi(chunk.text) : view.text + stripAnsi(chunk.text);
  const lines = text.split("\n");
  const kept = lines.length > maxLines ? lines.slice(lines.length - maxLines).join("\n") : text;
  return { text: kept, end: chunk.offset + new TextEncoder().encode(chunk.text).length };
}
