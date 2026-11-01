/** Lines `start..end` (1-based, `end` exclusive). `start === end` is an empty range. Mirrors `LineRange` (src-tauri/src/ide/line_diff.rs). */
export type LineRange = { start: number; end: number };

/**
 * Original lines `original` became modified lines `modified`; an empty side marks a pure insertion or deletion. Mirrors
 * `ChangeBlock` (src-tauri/src/ide/line_diff.rs).
 */
export type ChangeBlock = { original: LineRange; modified: LineRange };

/** Line diff of two texts as change blocks in document order, as `commands.diffLines` computes it. */
export type LineDiff = (oldText: string, newText: string) => Promise<ChangeBlock[]>;
