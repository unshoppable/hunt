/**
 * Lines selected in a changed file, in its working-tree version or, with `isOriginal`, in the version its diff compares
 * against; line numbers are 1-based and inclusive.
 */
export type SelectionContext = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  /** The lines were selected on the original (left) side of a diff, so they number the version before the changes. */
  isOriginal?: boolean;
  /** What the sub chat is for when it was not opened from a code selection (see guardrails); replaces the default framing. */
  task?: string;
  /** The chat is about the folder `path` (a changelist folder row) rather than a file; `text` is empty then. */
  isFolder?: boolean;
};
