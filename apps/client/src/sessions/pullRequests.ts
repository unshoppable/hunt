import type { PullRequest, ViewerReview } from "../ipc/types";

/** The signed-in user's part in a pull request's review as the filter offers it; `none` where they have none. */
export type ReviewFilter = ViewerReview | "none";

/** The filters below the search field; `null` keeps every author or review state. */
export type PullRequestFilter = { author: string | null; review: ReviewFilter | null; hidesDrafts: boolean };

export const NO_PULL_REQUEST_FILTER: PullRequestFilter = { author: null, review: null, hidesDrafts: false };

/** The logins of everyone who opened one of `pullRequests`, each once, sorted case-insensitively. */
export function pullRequestAuthors(pullRequests: PullRequest[]): string[] {
  const logins = new Set(pullRequests.map((pullRequest) => pullRequest.author));
  return [...logins].sort((first, second) => first.localeCompare(second, undefined, { sensitivity: "base" }));
}

/** Whether `filter` drops any pull request at all. */
export function isFiltering(filter: PullRequestFilter): boolean {
  return filter.author !== null || filter.review !== null || filter.hidesDrafts;
}

/**
 * Pull requests matching the popover search and `filter`: every word of `query` must occur in the number (`#261` or
 * `261`), the title, the author's login, the branch name or a label, case-insensitively. A blank query and
 * `NO_PULL_REQUEST_FILTER` keep everything.
 */
export function filterPullRequests(pullRequests: PullRequest[], query: string, filter: PullRequestFilter = NO_PULL_REQUEST_FILTER): PullRequest[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 && !isFiltering(filter)) return pullRequests;
  return pullRequests.filter((pullRequest) => {
    if (filter.author !== null && pullRequest.author !== filter.author) return false;
    if (filter.review !== null && (pullRequest.viewerReview ?? "none") !== filter.review) return false;
    if (filter.hidesDrafts && pullRequest.isDraft) return false;
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
