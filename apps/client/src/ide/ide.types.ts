/**
 * What the Prettier a worktree installs made of a file: `installed` is false when no Prettier resolves from the file,
 * `formatted` is null when Prettier ignores the file or has no parser for it.
 */
export type PrettierOutput = { installed: boolean; formatted: string | null };

/**
 * A file to show in an editor window, with an optional 1-based caret position. With `definitionOf` (the name
 * ⌘clicked at the position, e.g. in a diff) the window shows that name's declaration instead when the language
 * server knows one elsewhere inside the worktree, otherwise the position itself. With `revealInTree` the project tree
 * selects the file as on ⇧⌘2. With `revealFirstChange` and no `line` the caret goes to the file's first change against
 * its diff base, if it has one.
 */
export type EditorOpenRequest = {
  path: string;
  line?: number;
  column?: number;
  inRightSplit?: boolean;
  definitionOf?: string;
  revealInTree?: boolean;
  revealFirstChange?: boolean;
  /** `path` is a folder: the project tree reveals and expands it, and no file opens. */
  isFolder?: boolean;
};
