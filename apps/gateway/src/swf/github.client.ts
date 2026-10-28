/**
 * The GitHub calls of hunt-swf (`swf/poller.service.ts`) with the installation token of the repository (`swf/github-app.client.ts`): open issues
 * with a label, their comments, labels and comments on an issue, the repository labels the poller sets, the pull
 * request of a session (its files, reviews, branch update and merge; REST), its state with the checks of its head
 * commit and the status of an issue in the projects (Projects v2) it is an item of (GraphQL). Plain `fetch`; no
 * dependencies.
 */
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import type { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { PullRequestState } from "../../../../libs/domain/src/swf/pull-request-state.value-object.ts";
import { ERROR_TEXT_LIMIT, failure } from "../shared/http-failure.utils.ts";
import type { PullRequestReview } from "./pipeline.domain.ts";

const API = "https://api.github.com";
const PER_PAGE = 100;

export type IssueState = "open" | "closed";

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  /** ISO 8601. */
  createdAt: string;
  url: string;
  /** The names of the issue's labels. */
  labels: string[];
  state: IssueState;
  /** The logins of the issue's assignees. */
  assignees: string[];
}

export interface IssueComment {
  id: number;
  author: string;
  createdAt: string;
  body: string;
}

export interface LabelSpec {
  name: string;
  /** Six hex digits without `#`. */
  color: string;
  description: string;
}

export interface GitHub {
  /** The open issues of `repo` with `label`, oldest first; pull requests are left out. */
  openIssues(repo: Repository, label: string): Promise<Issue[]>;
  /** The issue with its current labels and state; null when it does not exist (any more). */
  issue(repo: Repository, issue: number): Promise<Issue | null>;
  /** Every comment of the issue, oldest first. */
  comments(repo: Repository, issue: number): Promise<IssueComment[]>;
  /** Removes `label` from the issue; false when the issue did not have it. */
  removeLabel(repo: Repository, issue: number, label: string): Promise<boolean>;
  addLabels(repo: Repository, issue: number, labels: string[]): Promise<void>;
  /** Comments on the issue or pull request and gives the comment's id. */
  comment(repo: Repository, issue: number, body: string): Promise<number>;
  /** Replaces the body of the comment `id`. */
  updateComment(repo: Repository, id: number, body: string): Promise<void>;
  /** The pull request with the checks of its head commit; null when it does not exist. */
  pullRequest(repo: Repository, number: number): Promise<PullRequestState | null>;
  /** The paths of the files the pull request changes. */
  pullRequestFiles(repo: Repository, number: number): Promise<string[]>;
  /** The reviews of the pull request, oldest first. */
  reviews(repo: Repository, number: number): Promise<PullRequestReview[]>;
  /** The inline comments of the review `review` as `path: body` lines. */
  reviewComments(repo: Repository, number: number, review: number): Promise<string[]>;
  /** Asks `logins` to review the pull request; a login that cannot be requested is skipped. */
  requestReviewers(repo: Repository, number: number, logins: string[]): Promise<void>;
  /** Merges the base branch into the pull request's branch. */
  updateBranch(repo: Repository, number: number): Promise<void>;
  /** Squash-merges the pull request. */
  merge(repo: Repository, number: number): Promise<void>;
  /** Creates the repository label unless it exists. */
  ensureLabel(repo: Repository, label: LabelSpec): Promise<void>;
  /**
   * Sets the `Status` field of the issue's item in every project it belongs to that has an option named `status`
   * (case-insensitive) and gives their titles; a project without such an option, or without a `Status` field, is left
   * as it is. The app's installation needs the organization permission "Projects: read and write".
   */
  moveToStatus(repo: Repository, issue: number, status: string): Promise<string[]>;
}

/** The issue's project items as the GraphQL query `PROJECT_ITEMS_QUERY` returns them. */
interface RawProjectItem {
  id?: unknown;
  project?: {
    id?: unknown;
    title?: unknown;
    field?: { id?: unknown; options?: { id?: unknown; name?: unknown }[] } | null;
  } | null;
}

const PROJECT_ITEMS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      projectItems(first: 50) {
        nodes {
          id
          project {
            id
            title
            field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
          }
        }
      }
    }
  }
}`;

const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title state merged headRefOid mergeStateStatus
      labels(first: 50) { nodes { name } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name conclusion status }
        ... on StatusContext { context state }
      } } } } } }
    }
  }
}`;

const SET_STATUS_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) {
    projectV2Item { id }
  }
}`;

/** The project items of an issue whose project has a `Status` option named `status`, with the IDs the mutation needs. */
export function statusTargets(items: unknown, status: string): { item: string; project: string; title: string; field: string; option: string }[] {
  if (!Array.isArray(items)) return [];
  const targets: { item: string; project: string; title: string; field: string; option: string }[] = [];
  for (const raw of items as RawProjectItem[]) {
    const project = raw?.project;
    if (typeof raw?.id !== "string" || typeof project?.id !== "string" || typeof project.field?.id !== "string") continue;
    const option = (project.field.options ?? []).find(
      (candidate) => typeof candidate?.name === "string" && candidate.name.toLowerCase() === status.toLowerCase(),
    );
    if (typeof option?.id !== "string") continue;
    const title = typeof project.title === "string" ? project.title : "";
    targets.push({ item: raw.id, project: project.id, title, field: project.field.id, option: option.id });
  }
  return targets;
}

/** The checks of a head commit as the GraphQL `statusCheckRollup` reports them, and the names of the failing ones. */
export function checksOf(rollup: unknown): { checks: PullRequestState["checks"]; failingChecks: string[] } {
  if (!isRecord(rollup)) return { checks: "none", failingChecks: [] };
  const failingChecks: string[] = [];
  const contexts = isRecord(rollup.contexts) && Array.isArray(rollup.contexts.nodes) ? rollup.contexts.nodes : [];
  for (const context of contexts as unknown[]) {
    if (!isRecord(context)) continue;
    const isFailedRun =
      context.__typename === "CheckRun" && ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(context.conclusion));
    const isFailedStatus = context.__typename === "StatusContext" && ["FAILURE", "ERROR"].includes(String(context.state));
    if (isFailedRun || isFailedStatus) {
      failingChecks.push(String(context.name ?? context.context ?? "check"));
    }
  }
  switch (rollup.state) {
    case "SUCCESS":
      return { checks: "success", failingChecks };
    case "FAILURE":
    case "ERROR":
      return { checks: "failure", failingChecks };
    case "PENDING":
    case "EXPECTED":
      return { checks: "pending", failingChecks };
    default:
      return { checks: "none", failingChecks };
  }
}

/** The pull request of the GraphQL query `PULL_REQUEST_QUERY`; null without one. */
export function parsePullRequest(data: unknown): PullRequestState | null {
  const pullRequest = isRecord(data) && isRecord(data.repository) && isRecord(data.repository.pullRequest) ? data.repository.pullRequest : null;
  if (!pullRequest || typeof pullRequest.number !== "number") return null;
  const commits = isRecord(pullRequest.commits) && Array.isArray(pullRequest.commits.nodes) ? (pullRequest.commits.nodes as unknown[]) : [];
  const lastCommitNode = commits[0];
  const commit = isRecord(lastCommitNode) && isRecord(lastCommitNode.commit) ? lastCommitNode.commit : null;
  const { checks, failingChecks } = checksOf(commit?.statusCheckRollup);
  const labels = isRecord(pullRequest.labels) && Array.isArray(pullRequest.labels.nodes) ? labelNames(pullRequest.labels.nodes) : [];
  return new PullRequestState({
    number: pullRequest.number,
    url: typeof pullRequest.url === "string" ? pullRequest.url : "",
    title: typeof pullRequest.title === "string" ? pullRequest.title : "",
    headSha: typeof pullRequest.headRefOid === "string" ? pullRequest.headRefOid : "",
    state: pullRequest.merged === true ? "merged" : pullRequest.state === "CLOSED" ? "closed" : "open",
    mergeState: typeof pullRequest.mergeStateStatus === "string" ? pullRequest.mergeStateStatus : "UNKNOWN",
    checks,
    failingChecks,
    labels,
  });
}

/** The URL of the `next` page in a `Link` header; null on the last page. */
export function nextPageUrl(link: string | null): string | null {
  for (const part of (link ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return null;
}

interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  created_at?: unknown;
  html_url?: unknown;
  pull_request?: unknown;
  labels?: unknown;
  state?: unknown;
  assignees?: unknown;
  id?: unknown;
}

/** The names of an issue's labels, which GitHub lists as objects with a `name` or, per its schema, as plain strings. */
function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label: unknown) => (typeof label === "string" ? label : (label as { name?: unknown } | null)?.name))
    .filter((name): name is string => typeof name === "string" && name !== "");
}

/** The issues of a list response; pull requests, which the issues API lists too, are left out. */
export function parseIssues(items: unknown[]): Issue[] {
  return (items as RawIssue[])
    .filter((item) => item.pull_request === undefined && typeof item.number === "number")
    .map((item) => ({
      number: item.number as number,
      title: typeof item.title === "string" ? item.title : "",
      body: typeof item.body === "string" ? item.body : "",
      author: typeof item.user?.login === "string" ? item.user.login : "ghost",
      createdAt: typeof item.created_at === "string" ? item.created_at : "",
      url: typeof item.html_url === "string" ? item.html_url : "",
      labels: labelNames(item.labels),
      state: item.state === "closed" ? "closed" : "open",
      assignees: Array.isArray(item.assignees)
        ? item.assignees
            .map((assignee: unknown) => (assignee as { login?: unknown } | null)?.login)
            .filter((login): login is string => typeof login === "string")
        : [],
    }));
}

export function parseComments(items: unknown[]): IssueComment[] {
  return (items as RawIssue[]).map((item) => ({
    id: typeof item.id === "number" ? item.id : 0,
    author: typeof item.user?.login === "string" ? item.user.login : "ghost",
    createdAt: typeof item.created_at === "string" ? item.created_at : "",
    body: typeof item.body === "string" ? item.body : "",
  }));
}

/** `tokenFor` gives the token every call to a repository goes with; it is asked per request, so a renewed token counts. */
export function createGitHub(tokenFor: (repo: Repository) => Promise<string>, fetchImpl: typeof fetch = fetch): GitHub {
  async function call(repo: Repository, method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${await tokenFor(repo)}`,
      "User-Agent": "hunt-swf",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    // Pagination links are absolute; the token goes to GitHub's API only.
    if (!path.startsWith("/") && !path.startsWith(`${API}/`)) throw new Error(`refused to call ${path.slice(0, 100)} with the GitHub token`);
    const url = path.startsWith("/") ? `${API}${path}` : path;
    return fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** The `data` of a GraphQL call; GraphQL reports errors with HTTP 200 in `errors`, which count as a failure too. */
  async function graphql(repo: Repository, query: string, variables: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    const response = await call(repo, "POST", "/graphql", { query, variables });
    if (!response.ok) throw await failure(response, what);
    const result = (await response.json()) as { data?: Record<string, unknown>; errors?: { message?: unknown }[] };
    if (result.errors?.length) {
      const messages = result.errors.map((error) => (typeof error.message === "string" ? error.message : "unknown error")).join("; ");
      throw new Error(`failed to ${what}: ${messages.slice(0, ERROR_TEXT_LIMIT)}`);
    }
    return result.data ?? {};
  }

  /** Every item of a paginated list of `repo`. */
  async function list(repo: Repository, path: string, what: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = path;
    while (next) {
      const response = await call(repo, "GET", next);
      if (!response.ok) throw await failure(response, what);
      items.push(...((await response.json()) as unknown[]));
      next = nextPageUrl(response.headers.get("link"));
    }
    return items;
  }

  return {
    async openIssues(repo, label) {
      const query = `state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=${PER_PAGE}`;
      return parseIssues(await list(repo, `/repos/${repo.path}/issues?${query}`, `list the issues of ${repo.slug} labelled ${label}`));
    },
    async issue(repo, issue) {
      const response = await call(repo, "GET", `/repos/${repo.path}/issues/${issue}`);
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response, `read ${repo.slug}#${issue}`);
      return parseIssues([await response.json()])[0] ?? null;
    },
    async comments(repo, issue) {
      return parseComments(await list(repo, `/repos/${repo.path}/issues/${issue}/comments?per_page=${PER_PAGE}`, `read the comments of ${repo.slug}#${issue}`));
    },
    async removeLabel(repo, issue, label) {
      const response = await call(repo, "DELETE", `/repos/${repo.path}/issues/${issue}/labels/${encodeURIComponent(label)}`);
      if (response.status === 404) return false;
      if (!response.ok) throw await failure(response, `remove the label ${label} from ${repo.slug}#${issue}`);
      return true;
    },
    async addLabels(repo, issue, labels) {
      const response = await call(repo, "POST", `/repos/${repo.path}/issues/${issue}/labels`, { labels });
      if (!response.ok) throw await failure(response, `label ${repo.slug}#${issue} with ${labels.join(", ")}`);
    },
    async comment(repo, issue, body) {
      const response = await call(repo, "POST", `/repos/${repo.path}/issues/${issue}/comments`, { body });
      if (!response.ok) throw await failure(response, `comment on ${repo.slug}#${issue}`);
      const created = (await response.json()) as { id?: unknown };
      return typeof created.id === "number" ? created.id : 0;
    },
    async updateComment(repo, id, body) {
      const response = await call(repo, "PATCH", `/repos/${repo.path}/issues/comments/${id}`, { body });
      if (!response.ok) throw await failure(response, `update the comment ${id} of ${repo.slug}`);
    },
    async pullRequest(repo, number) {
      const { owner, name } = repo;
      const data = await graphql(repo, PULL_REQUEST_QUERY, { owner, name, number }, `read the pull request ${repo.slug}#${number}`);
      return parsePullRequest(data);
    },
    async pullRequestFiles(repo, number) {
      const items = await list(repo, `/repos/${repo.path}/pulls/${number}/files?per_page=${PER_PAGE}`, `list the files of ${repo.slug}#${number}`);
      return items.map((item) => (item as { filename?: unknown }).filename).filter((filename): filename is string => typeof filename === "string");
    },
    async reviews(repo, number) {
      const items = await list(repo, `/repos/${repo.path}/pulls/${number}/reviews?per_page=${PER_PAGE}`, `list the reviews of ${repo.slug}#${number}`);
      return (items as { id?: unknown; user?: { login?: unknown } | null; state?: unknown; body?: unknown; submitted_at?: unknown }[])
        .filter((item) => typeof item.id === "number")
        .map((item) => ({
          id: item.id as number,
          author: typeof item.user?.login === "string" ? item.user.login : "ghost",
          state: typeof item.state === "string" ? item.state : "",
          body: typeof item.body === "string" ? item.body : "",
          submittedAt: typeof item.submitted_at === "string" ? item.submitted_at : "",
        }));
    },
    async reviewComments(repo, number, review) {
      const path = `/repos/${repo.path}/pulls/${number}/reviews/${review}/comments?per_page=${PER_PAGE}`;
      const items = await list(repo, path, `list the comments of review ${review} of ${repo.slug}#${number}`);
      return (items as { path?: unknown; line?: unknown; body?: unknown }[])
        .filter((item) => typeof item.body === "string")
        .map((item) => `${typeof item.path === "string" ? item.path : "?"}${typeof item.line === "number" ? `:${item.line}` : ""}: ${item.body as string}`);
    },
    async requestReviewers(repo, number, logins) {
      if (logins.length === 0) return;
      const response = await call(repo, "POST", `/repos/${repo.path}/pulls/${number}/requested_reviewers`, { reviewers: logins });
      // 422: a login that is the author or no collaborator; the mention in the comment still reaches them.
      if (!response.ok && response.status !== 422) throw await failure(response, `request reviews of ${repo.slug}#${number}`);
    },
    async updateBranch(repo, number) {
      const response = await call(repo, "PUT", `/repos/${repo.path}/pulls/${number}/update-branch`, {});
      // 202: accepted; 422: the branch is up to date already or cannot be updated, which the next poll's merge state shows.
      if (!response.ok && response.status !== 422) throw await failure(response, `update the branch of ${repo.slug}#${number}`);
    },
    async merge(repo, number) {
      const response = await call(repo, "PUT", `/repos/${repo.path}/pulls/${number}/merge`, { merge_method: "squash" });
      if (!response.ok) throw await failure(response, `merge ${repo.slug}#${number}`);
    },
    async ensureLabel(repo, label) {
      const existing = await call(repo, "GET", `/repos/${repo.path}/labels/${encodeURIComponent(label.name)}`);
      if (existing.ok) return;
      if (existing.status !== 404) throw await failure(existing, `look up the label ${label.name} of ${repo.slug}`);
      const created = await call(repo, "POST", `/repos/${repo.path}/labels`, label);
      // 422: created meanwhile.
      if (!created.ok && created.status !== 422) throw await failure(created, `create the label ${label.name} in ${repo.slug}`);
    },
    async moveToStatus(repo, issue, status) {
      const { owner, name } = repo;
      const data = await graphql(repo, PROJECT_ITEMS_QUERY, { owner, name, number: issue }, `read the projects of ${repo.slug}#${issue}`);
      const items = (data as { repository?: { issue?: { projectItems?: { nodes?: unknown } } } }).repository?.issue?.projectItems?.nodes;
      const moved: string[] = [];
      for (const target of statusTargets(items, status)) {
        const variables = { project: target.project, item: target.item, field: target.field, option: target.option };
        await graphql(repo, SET_STATUS_MUTATION, variables, `set the status of ${repo.slug}#${issue} to ${status} in the project ${target.title}`);
        moved.push(target.title);
      }
      return moved;
    },
  };
}
