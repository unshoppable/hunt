/**
 * The GitHub REST calls of hunt-swf (`swf.ts`) with the poller's token: open issues with a label, their comments,
 * labels and comments on an issue, and the repository labels the poller sets. Plain `fetch`; no dependencies.
 */

const API = "https://api.github.com";
const PER_PAGE = 100;
const ERROR_TEXT_LIMIT = 300;

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
}

export interface IssueComment {
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
  openIssues(repo: string, label: string): Promise<Issue[]>;
  /** Every comment of the issue, oldest first. */
  comments(repo: string, issue: number): Promise<IssueComment[]>;
  /** Removes `label` from the issue; false when the issue did not have it. */
  removeLabel(repo: string, issue: number, label: string): Promise<boolean>;
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  comment(repo: string, issue: number, body: string): Promise<void>;
  /** Creates the repository label unless it exists. */
  ensureLabel(repo: string, label: LabelSpec): Promise<void>;
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
    }));
}

export function parseComments(items: unknown[]): IssueComment[] {
  return (items as RawIssue[]).map((item) => ({
    author: typeof item.user?.login === "string" ? item.user.login : "ghost",
    createdAt: typeof item.created_at === "string" ? item.created_at : "",
    body: typeof item.body === "string" ? item.body : "",
  }));
}

/** `owner/repo` for a URL path; both parts were validated by `swfConfig.ts`. */
function repoPath(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

export function createGitHub(token: string, fetchImpl: typeof fetch = fetch): GitHub {
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "hunt-swf",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    // Pagination links are absolute; the token goes to GitHub's API only.
    if (!path.startsWith("/") && !path.startsWith(`${API}/`)) throw new Error(`refused to call ${path.slice(0, 100)} with the GitHub token`);
    const url = path.startsWith("/") ? `${API}${path}` : path;
    return fetchImpl(url,{ method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async function failure(response: Response, what: string): Promise<Error> {
    const text = (await response.text()).replace(/\s+/g, " ").slice(0, ERROR_TEXT_LIMIT);
    return new Error(`failed to ${what}: HTTP ${response.status} ${text}`);
  }

  /** Every item of a paginated list. */
  async function list(path: string, what: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = path;
    while (next) {
      const response = await call("GET", next);
      if (!response.ok) throw await failure(response, what);
      items.push(...((await response.json()) as unknown[]));
      next = nextPageUrl(response.headers.get("link"));
    }
    return items;
  }

  return {
    async openIssues(repo, label) {
      const query = `state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=${PER_PAGE}`;
      return parseIssues(await list(`/repos/${repoPath(repo)}/issues?${query}`, `list the issues of ${repo} labelled ${label}`));
    },
    async comments(repo, issue) {
      return parseComments(await list(`/repos/${repoPath(repo)}/issues/${issue}/comments?per_page=${PER_PAGE}`, `read the comments of ${repo}#${issue}`));
    },
    async removeLabel(repo, issue, label) {
      const response = await call("DELETE", `/repos/${repoPath(repo)}/issues/${issue}/labels/${encodeURIComponent(label)}`);
      if (response.status === 404) return false;
      if (!response.ok) throw await failure(response, `remove the label ${label} from ${repo}#${issue}`);
      return true;
    },
    async addLabels(repo, issue, labels) {
      const response = await call("POST", `/repos/${repoPath(repo)}/issues/${issue}/labels`, { labels });
      if (!response.ok) throw await failure(response, `label ${repo}#${issue} with ${labels.join(", ")}`);
    },
    async comment(repo, issue, body) {
      const response = await call("POST", `/repos/${repoPath(repo)}/issues/${issue}/comments`, { body });
      if (!response.ok) throw await failure(response, `comment on ${repo}#${issue}`);
    },
    async ensureLabel(repo, label) {
      const existing = await call("GET", `/repos/${repoPath(repo)}/labels/${encodeURIComponent(label.name)}`);
      if (existing.ok) return;
      if (existing.status !== 404) throw await failure(existing, `look up the label ${label.name} of ${repo}`);
      const created = await call("POST", `/repos/${repoPath(repo)}/labels`, label);
      // 422: created meanwhile.
      if (!created.ok && created.status !== 422) throw await failure(created, `create the label ${label.name} in ${repo}`);
    },
  };
}
