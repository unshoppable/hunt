export type ChangedFile = {
  path: string;
  /** Single-letter git status: A, M, D, R, or ? for untracked. */
  status: string;
};
