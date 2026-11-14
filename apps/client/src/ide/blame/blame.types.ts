/** A commit that lines of a blamed file come from. */
export type BlameCommit = {
  id: string;
  author: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
};

/** The commit that last changed each line of a file: per line the index of its commit in `commits`, or null for a line no commit holds yet. */
export type Blame = { commits: BlameCommit[]; lines: (number | null)[] };

/** The commit of each line of a file, in line order; null for a line no commit holds. */
export type LineCommits = readonly (BlameCommit | null)[];
