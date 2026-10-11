import type { PullRequest } from "../ipc/types";

/**
 * Pull requests matching the popover search: every word of `query` must occur in the number (`#261` or `261`), the
 * title, the author's login, the branch name or a label, case-insensitively. A blank query keeps everything.
 */
export function filterPullRequests(pullRequests: PullRequest[], query: string): PullRequest[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return pullRequests;
  return pullRequests.filter((pullRequest) => {
    const labels = pullRequest.labels.map((label) => label.name).join(" ");
    const haystack = `#${pullRequest.number} ${pullRequest.title} ${pullRequest.author} ${pullRequest.headRefName} ${labels}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The name under which the branch of a pull request is known in the repository: the local branch of that name,
 * else its copy on `origin`, else on any other remote; `null` when the branch was never fetched.
 */
export function findPullRequestBranch(branches: string[], headRefName: string): string | null {
  if (branches.includes(headRefName)) return headRefName;
  const origin = `origin/${headRefName}`;
  if (branches.includes(origin)) return origin;
  return branches.find((branch) => branch.endsWith(`/${headRefName}`)) ?? null;
}
