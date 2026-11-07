import type { Commit, CommitDetails, RefList } from "../git/git.types";
import type { GitLogFilter } from "../sessions/inspector.store";

/** A commit of the log as `hunt-client git` lists it; `date` is when it was authored. */
export type LogEntry = { sha: string; subject: string; author: string; date: string };

/** A local branch as `hunt-client git` lists it: its upstream, how far it is ahead of and behind that, whether a worktree has it checked out. */
export type LocalBranchEntry = { name: string; upstream: string | null; ahead: number; behind: number; isCheckedOut: boolean };

/** The branches and tags of a repository in short: the local branches, the remote branches and the tags by name, and how many commits a push would publish. */
export type RefsSummary = { local: LocalBranchEntry[]; remote: string[]; tags: string[]; unpushed: number };

/** The selected commit as `hunt-client git` reports it: its message, committer, the branches containing it and its files. */
export type CommitEntry = Omit<CommitDetails, "id"> & { sha: string };

export function logEntry(commit: Commit): LogEntry {
  return { sha: commit.id, subject: commit.subject, author: commit.author, date: commit.authoredAt };
}

export function commitEntry({ id, ...details }: CommitDetails): CommitEntry {
  return { sha: id, ...details };
}

export function refsSummary(refs: RefList): RefsSummary {
  const local = refs.refs
    .filter((ref) => ref.kind === "local")
    .map((ref) => ({ name: ref.name, upstream: ref.upstream, ahead: ref.ahead, behind: ref.behind, isCheckedOut: ref.worktreePath !== null }));
  const namesOf = (kind: "remote" | "tag") => refs.refs.filter((ref) => ref.kind === kind).map((ref) => ref.name);
  return { local, remote: namesOf("remote"), tags: namesOf("tag"), unpushed: refs.unpushed.length };
}

/** `filter` in words: the history it shows and the text it looks for. */
export function describeLogFilter(filter: GitLogFilter): string {
  const history = filter.reference ? `the history of ${filter.reference}` : "the history of every branch and tag";
  return filter.text ? `${history} matching "${filter.text}"` : history;
}

/** The commits of `commits` whose hash starts with `sha`, in any case. */
export function commitsStartingWith(commits: readonly Commit[], sha: string): Commit[] {
  const prefix = sha.toLowerCase();
  return commits.filter((commit) => commit.id.startsWith(prefix));
}
