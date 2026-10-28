/** Pure helpers of the window replicas of shared documents (`documents.service.ts`, `src-tauri/src/ide/documents.rs`). */

/** What a replica does with a change that another window or the backend made. */
export type RemoteChangeAction = "apply" | "ignore" | "resync";

/**
 * A replica at `version` applies the change to `eventVersion` that directly follows it. It already holds an older or
 * equal one, and a busy replica (own edits in flight, a re-read pending) skips it, since the busy step ends with a check
 * against the newest version seen. A gap means a missed change, so the replica reads the document again.
 */
export function remoteChangeAction(version: number, isBusy: boolean, eventVersion: number): RemoteChangeAction {
  if (eventVersion <= version || isBusy) return "ignore";
  return eventVersion === version + 1 ? "apply" : "resync";
}

/** A replacement of `oldText.slice(start, end)` by `text`. */
export type TextReplacement = { start: number; end: number; text: string };

/**
 * The one replacement that turns `oldText` into `newText`: everything between their common start and end, which never
 * splits a surrogate pair or a CRLF. Null when both are equal.
 */
export function minimalChange(oldText: string, newText: string): TextReplacement | null {
  if (oldText === newText) return null;
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }
  if (prefix > 0 && (isUnsplittable(oldText, prefix) || isUnsplittable(newText, prefix))) {
    prefix--;
  }
  let suffix = 0;
  while (suffix < limit - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) {
    suffix++;
  }
  if (suffix > 0 && (isUnsplittable(oldText, oldText.length - suffix) || isUnsplittable(newText, newText.length - suffix))) {
    suffix--;
  }
  return { start: prefix, end: oldText.length - suffix, text: newText.slice(prefix, newText.length - suffix) };
}

/** Whether `offset` falls between the halves of a surrogate pair or between the CR and LF of a CRLF in `text`. */
function isUnsplittable(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  const isPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return isPair || (before === 13 && after === 10);
}
