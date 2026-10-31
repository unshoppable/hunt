/** One commit of the Git tab's log. */
export type Commit = {
  id: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  /** Branches and tags at the commit as `git log --decorate` names them: `HEAD -> master`, `origin/master`, `tag: v1.0`. */
  refs: string[];
};

/**
 * A page of the log: the commits reachable from `reference` (every branch, remote branch and tag when empty) whose
 * message contains `text`, or the one commit `text` names; `skip` and `limit` page through them, newest first.
 */
export type LogQuery = { reference: string; text: string; skip: number; limit: number };

/** How a reset moves the branch: `soft` keeps index and files, `mixed` the files, `hard` drops every uncommitted change, `keep` keeps them and fails when one is in the way. */
export type ResetMode = "soft" | "mixed" | "hard" | "keep";

export type RefKind = "local" | "remote" | "tag";

/** A branch or tag; `target` is the commit it points at and `upstream` the short name of a local branch's upstream. */
export type GitRef = {
  name: string;
  kind: RefKind;
  target: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The worktree (main checkout or linked) that has the local branch checked out; git refuses to delete such a branch. */
  worktreePath: string | null;
};

/** Every branch and tag, the checked-out branch (`HEAD` when detached) and the commits a push would publish. */
export type RefList = { head: string; refs: GitRef[]; unpushed: string[] };

/** What the Git tab works on: a session's worktree, or a repository's own checkout while no session is active. */
export type GitScope = { kind: "session"; id: string } | { kind: "repo"; path: string };

/** A file a commit changed; `oldPath` is set for a rename. */
export type CommitFile = { path: string; status: string; oldPath: string | null };

/** What the log shows for a selected commit: the full message, who committed it when, its files and the branches containing it. */
export type CommitDetails = { id: string; message: string; committer: string; committedAt: string; files: CommitFile[]; branches: string[] };
