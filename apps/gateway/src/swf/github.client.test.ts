import { describe, expect, it } from "vitest";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { checksOf, createGitHub, nextPageUrl, parseComments, parseIssues, parsePullRequest, statusTargets } from "./github.client.ts";

const API = "https://api.github.com";
const ACME_APP = Repository.fromSlug("acme/app");
const ACME_OTHER = Repository.fromSlug("acme/other");

/** A fetch that answers from `answers` by `<METHOD> <path or URL>` and records each request. */
function fakeFetch(answers: Record<string, () => Response>) {
  const requests: { key: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url.startsWith(API) ? url.slice(API.length) : url}`;
    requests.push({ key, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected request ${key}`);
    return answer();
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

describe("nextPageUrl", () => {
  it("finds the next page in a Link header", () => {
    const link = '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=5>; rel="last"';
    expect(nextPageUrl(link)).toBe("https://api.github.com/repositories/1/issues?page=2");
    expect(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
  });
});

describe("parseIssues", () => {
  it("leaves pull requests out, takes the label names and the assignees' logins and fills in missing fields", () => {
    const issues = parseIssues([
      {
        number: 3,
        title: "Fix login",
        body: null,
        user: { login: "alice" },
        created_at: "2026-10-13T08:00:00Z",
        html_url: "https://github.com/acme/app/issues/3",
        labels: [{ id: 1, name: "swf" }, "bug", { id: 2 }, null],
        state: "closed",
        assignees: [{ login: "carol" }, null, { id: 3 }, { login: "dave" }],
      },
      { number: 4, title: "A pull request", pull_request: { url: "x" } },
      { number: 5, title: "Deleted author", user: null },
    ]);
    expect(issues).toEqual([
      {
        number: 3,
        title: "Fix login",
        body: "",
        author: "alice",
        createdAt: "2026-10-13T08:00:00Z",
        url: "https://github.com/acme/app/issues/3",
        labels: ["swf", "bug"],
        state: "closed",
        assignees: ["carol", "dave"],
      },
      { number: 5, title: "Deleted author", body: "", author: "ghost", createdAt: "", url: "", labels: [], state: "open", assignees: [] },
    ]);
  });
});

describe("parseComments", () => {
  it("takes the id, the author and the body of each comment and fills in missing fields", () => {
    expect(parseComments([{ id: 7, user: { login: "bob" }, created_at: "2026-10-13T09:00:00Z", body: "Hi" }, { user: null }])).toEqual([
      { id: 7, author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Hi" },
      { id: 0, author: "ghost", createdAt: "", body: "" },
    ]);
  });
});

describe("checksOf", () => {
  it("maps the rollup's state and names the failing check runs and statuses", () => {
    const contexts = {
      nodes: [
        { __typename: "CheckRun", name: "build", conclusion: "FAILURE", status: "COMPLETED" },
        { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
        { __typename: "CheckRun", name: "e2e", conclusion: "TIMED_OUT", status: "COMPLETED" },
        { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
        { __typename: "StatusContext", context: "ci/other", state: "SUCCESS" },
        null,
      ],
    };
    expect(checksOf({ state: "FAILURE", contexts })).toEqual({ checks: "failure", failingChecks: ["build", "e2e", "ci/legacy"] });
    expect(checksOf({ state: "ERROR", contexts: { nodes: [] } })).toEqual({ checks: "failure", failingChecks: [] });
    expect(checksOf({ state: "SUCCESS" })).toEqual({ checks: "success", failingChecks: [] });
    expect(checksOf({ state: "PENDING" }).checks).toBe("pending");
    expect(checksOf({ state: "EXPECTED" }).checks).toBe("pending");
    expect(checksOf(null)).toEqual({ checks: "none", failingChecks: [] });
  });
});

describe("parsePullRequest", () => {
  const raw = {
    number: 31,
    url: "https://github.com/acme/app/pull/31",
    title: "feat: fix login",
    state: "OPEN",
    merged: false,
    headRefOid: "0123456789abcdef0123456789abcdef01234567",
    mergeStateStatus: "BEHIND",
    labels: { nodes: [{ name: "hunt:human-review" }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } }] },
  };

  it("reads the head, the merge state, the labels and the checks of the head commit", () => {
    expect(parsePullRequest({ repository: { pullRequest: raw } })).toEqual({
      number: 31,
      url: "https://github.com/acme/app/pull/31",
      title: "feat: fix login",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      state: "open",
      mergeState: "BEHIND",
      checks: "success",
      failingChecks: [],
      labels: ["hunt:human-review"],
    });
  });

  it("tells merged and closed pull requests apart and fills in missing fields", () => {
    expect(parsePullRequest({ repository: { pullRequest: { ...raw, state: "MERGED", merged: true } } })?.state).toBe("merged");
    expect(parsePullRequest({ repository: { pullRequest: { ...raw, state: "CLOSED" } } })?.state).toBe("closed");
    expect(parsePullRequest({ repository: { pullRequest: { number: 32 } } })).toEqual({
      number: 32,
      url: "",
      title: "",
      headSha: "",
      state: "open",
      mergeState: "UNKNOWN",
      checks: "none",
      failingChecks: [],
      labels: [],
    });
  });

  it("is null without a pull request", () => {
    expect(parsePullRequest({ repository: { pullRequest: null } })).toBeNull();
    expect(parsePullRequest({})).toBeNull();
  });
});

describe("createGitHub", () => {
  it("lists the open issues with the label page by page, oldest first, with the token", async () => {
    const page2 = `${API}/repositories/1/issues?page=2`;
    const { fetchImpl, requests } = fakeFetch({
      "GET /repos/acme/app/issues?state=open&labels=swf&sort=created&direction=asc&per_page=100": () =>
        Response.json([{ number: 1, title: "One" }], { headers: { Link: `<${page2}>; rel="next"` } }),
      "GET /repositories/1/issues?page=2": () => Response.json([{ number: 2, title: "Two" }, { number: 3, pull_request: {} }]),
    });

    const issues = await createGitHub(async () => "ghp_token", fetchImpl).openIssues(ACME_APP, "swf");
    expect(issues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(requests[0].headers.get("Authorization")).toBe("Bearer ghp_token");
    expect(requests[0].headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
  });

  it("asks the token of the repository for every request, the pages of a list included", async () => {
    const page2 = `${API}/repositories/1/issues?page=2`;
    const { fetchImpl, requests } = fakeFetch({
      "GET /repos/acme/app/issues?state=open&labels=swf&sort=created&direction=asc&per_page=100": () =>
        Response.json([{ number: 1, title: "One" }], { headers: { Link: `<${page2}>; rel="next"` } }),
      "GET /repositories/1/issues?page=2": () => Response.json([]),
      "GET /repos/acme/other/issues/2": () => Response.json({ number: 2 }),
    });
    const asked: string[] = [];
    const github = createGitHub(async (repo) => {
      asked.push(repo.slug);
      return `ghs_${repo.slug.replace("/", "_")}`;
    }, fetchImpl);

    await github.openIssues(ACME_APP, "swf");
    await github.issue(ACME_OTHER, 2);
    expect(asked).toEqual(["acme/app", "acme/app", "acme/other"]);
    expect(requests.map((request) => request.headers.get("Authorization"))).toEqual(["Bearer ghs_acme_app", "Bearer ghs_acme_app", "Bearer ghs_acme_other"]);
  });

  it("reads one issue with its labels and state, and reports a missing one as null", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/acme/app/issues/7": () => Response.json({ number: 7, title: "Seven", labels: [{ name: "swf:question" }], state: "open" }),
      "GET /repos/acme/app/issues/8": () => Response.json({ message: "Not Found" }, { status: 404 }),
      "GET /repos/acme/app/issues/9": () => new Response("down", { status: 503 }),
    });
    const github = createGitHub(async () => "ghp_token", fetchImpl);
    expect(await github.issue(ACME_APP, 7)).toMatchObject({ number: 7, labels: ["swf:question"], state: "open" });
    expect(await github.issue(ACME_APP, 8)).toBeNull();
    await expect(github.issue(ACME_APP, 9)).rejects.toThrow("failed to read acme/app#9: HTTP 503 down");
  });

  it("refuses to send the token to a host other than GitHub's API", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/acme/app/issues/1/comments?per_page=100": () => Response.json([], { headers: { Link: '<https://evil.example.com/x>; rel="next"' } }),
    });
    await expect(createGitHub(async () => "ghp_token", fetchImpl).comments(ACME_APP, 1)).rejects.toThrow("refused to call https://evil.example.com/x with the GitHub token");
  });

  it("removes a label, reporting whether the issue had it, and adds labels and comments", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "DELETE /repos/acme/app/issues/3/labels/swf": () => Response.json([]),
      "DELETE /repos/acme/app/issues/4/labels/swf": () => Response.json({ message: "Label does not exist" }, { status: 404 }),
      "DELETE /repos/acme/app/issues/5/labels/swf": () => new Response("forbidden", { status: 403 }),
      "POST /repos/acme/app/issues/3/labels": () => Response.json([]),
      "POST /repos/acme/app/issues/3/comments": () => Response.json({ id: 1234 }, { status: 201 }),
    });
    const github = createGitHub(async () => "ghp_token", fetchImpl);

    expect(await github.removeLabel(ACME_APP, 3, "swf")).toBe(true);
    expect(await github.removeLabel(ACME_APP, 4, "swf")).toBe(false);
    await expect(github.removeLabel(ACME_APP, 5, "swf")).rejects.toThrow("failed to remove the label swf from acme/app#5: HTTP 403 forbidden");
    await github.addLabels(ACME_APP, 3, ["swf:plan"]);
    expect(await github.comment(ACME_APP, 3, "Hunt started a session")).toBe(1234);
    expect(requests.slice(-2).map((request) => request.body)).toEqual([{ labels: ["swf:plan"] }, { body: "Hunt started a session" }]);
  });

  it("edits a comment in place", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "PATCH /repos/acme/app/issues/comments/1234": () => Response.json({ id: 1234 }),
      "PATCH /repos/acme/app/issues/comments/9": () => new Response("gone", { status: 404 }),
    });
    const github = createGitHub(async () => "ghp_token", fetchImpl);

    await github.updateComment(ACME_APP, 1234, "**Hunt:** step `implement`");
    expect(requests[0].body).toEqual({ body: "**Hunt:** step `implement`" });
    await expect(github.updateComment(ACME_APP, 9, "x")).rejects.toThrow("failed to update the comment 9 of acme/app: HTTP 404 gone");
  });

  it("reads the pull request through GraphQL, with the repository's owner, name and the number", async () => {
    const pullRequest = { number: 31, state: "OPEN", merged: false, headRefOid: "abc", mergeStateStatus: "CLEAN" };
    const answers = [Response.json({ data: { repository: { pullRequest } } }), Response.json({ data: { repository: { pullRequest: null } } })];
    const { fetchImpl, requests } = fakeFetch({ "POST /graphql": () => answers.shift() as Response });
    const github = createGitHub(async () => "ghp_token", fetchImpl);

    expect(await github.pullRequest(ACME_APP, 31)).toMatchObject({ number: 31, headSha: "abc", state: "open", mergeState: "CLEAN", checks: "none" });
    expect((requests[0].body as { variables: unknown }).variables).toEqual({ owner: "acme", name: "app", number: 31 });
    expect(await github.pullRequest(ACME_APP, 99)).toBeNull();
  });

  it("lists the files, the reviews and a review's inline comments of a pull request", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/acme/app/pulls/31/files?per_page=100": () => Response.json([{ filename: "README.md" }, { filename: "db/migrations/1.sql" }, {}]),
      "GET /repos/acme/app/pulls/31/reviews?per_page=100": () =>
        Response.json([
          { id: 501, user: { login: "carol" }, state: "CHANGES_REQUESTED", body: "Rename it.", submitted_at: "2026-10-14T08:00:00Z" },
          { id: 502, user: null, state: "APPROVED" },
          { user: { login: "nobody" }, state: "APPROVED" },
        ]),
      "GET /repos/acme/app/pulls/31/reviews/501/comments?per_page=100": () =>
        Response.json([{ path: "src/a.ts", line: 3, body: "Use a const." }, { path: "src/b.ts", body: "Outdated." }, { body: "No path." }, { path: "src/c.ts" }]),
    });
    const github = createGitHub(async () => "ghp_token", fetchImpl);

    expect(await github.pullRequestFiles(ACME_APP, 31)).toEqual(["README.md", "db/migrations/1.sql"]);
    expect(await github.reviews(ACME_APP, 31)).toEqual([
      { id: 501, author: "carol", state: "CHANGES_REQUESTED", body: "Rename it.", submittedAt: "2026-10-14T08:00:00Z" },
      { id: 502, author: "ghost", state: "APPROVED", body: "", submittedAt: "" },
    ]);
    expect(await github.reviewComments(ACME_APP, 31, 501)).toEqual(["src/a.ts:3: Use a const.", "src/b.ts: Outdated.", "?: No path."]);
  });

  it("requests reviewers, skips an empty request and accepts logins GitHub cannot request", async () => {
    const answers = [Response.json({}, { status: 201 }), Response.json({ message: "Reviews may only be requested from collaborators" }, { status: 422 }), new Response("down", { status: 502 })];
    const { fetchImpl, requests } = fakeFetch({ "POST /repos/acme/app/pulls/31/requested_reviewers": () => answers.shift() as Response });
    const github = createGitHub(async () => "ghp_token", fetchImpl);

    await github.requestReviewers(ACME_APP, 31, ["carol", "dave"]);
    await github.requestReviewers(ACME_APP, 31, []);
    await github.requestReviewers(ACME_APP, 31, ["outsider"]);
    await expect(github.requestReviewers(ACME_APP, 31, ["carol"])).rejects.toThrow("failed to request reviews of acme/app#31: HTTP 502 down");
    expect(requests.map((request) => request.body)).toEqual([{ reviewers: ["carol", "dave"] }, { reviewers: ["outsider"] }, { reviewers: ["carol"] }]);
  });

  it("updates the branch, accepting a branch that cannot be updated, and squash-merges", async () => {
    const updates = [Response.json({ message: "Updating pull request branch." }, { status: 202 }), Response.json({ message: "merge conflict" }, { status: 422 })];
    const merges = [Response.json({ merged: true }), Response.json({ message: "Pull Request is not mergeable" }, { status: 405 })];
    const { fetchImpl, requests } = fakeFetch({
      "PUT /repos/acme/app/pulls/31/update-branch": () => updates.shift() as Response,
      "PUT /repos/acme/app/pulls/31/merge": () => merges.shift() as Response,
    });
    const github = createGitHub(async () => "ghp_token", fetchImpl);

    await github.updateBranch(ACME_APP, 31);
    await github.updateBranch(ACME_APP, 31);
    await github.merge(ACME_APP, 31);
    await expect(github.merge(ACME_APP, 31)).rejects.toThrow('failed to merge acme/app#31: HTTP 405 {"message":"Pull Request is not mergeable"}');
    expect(requests.map((request) => request.body)).toEqual([{}, {}, { merge_method: "squash" }, { merge_method: "squash" }]);
  });

  it("creates a missing label and accepts one created meanwhile", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "GET /repos/acme/app/labels/swf%3Aplan": () => new Response("", { status: 404 }),
      "GET /repos/acme/app/labels/swf%3Adone": () => new Response("", { status: 404 }),
      "GET /repos/acme/app/labels/swf%3Afailed": () => Response.json({ name: "swf:failed" }),
      "POST /repos/acme/app/labels": () => Response.json({ message: "Validation Failed" }, { status: 422 }),
    });
    const github = createGitHub(async () => "ghp_token", fetchImpl);
    const label = { name: "swf:plan", color: "fbca04", description: "Hunt's agent reads the issue and plans" };

    await github.ensureLabel(ACME_APP, label);
    await github.ensureLabel(ACME_APP, { ...label, name: "swf:done" });
    await github.ensureLabel(ACME_APP, { ...label, name: "swf:failed" });
    expect(requests.map((request) => request.key)).toEqual([
      "GET /repos/acme/app/labels/swf%3Aplan",
      "POST /repos/acme/app/labels",
      "GET /repos/acme/app/labels/swf%3Adone",
      "POST /repos/acme/app/labels",
      "GET /repos/acme/app/labels/swf%3Afailed",
    ]);
    expect(requests[1].body).toEqual(label);
  });

  it("sets the status of the issue's item in every project with a matching option and names those projects", async () => {
    const items = [
      { id: "item1", project: { id: "p1", title: "Board", field: { id: "f1", options: [{ id: "todo", name: "Todo" }, { id: "wip", name: "In progress" }] } } },
      { id: "item2", project: { id: "p2", title: "No status", field: null } },
      { id: "item3", project: { id: "p3", title: "Other options", field: { id: "f3", options: [{ id: "x", name: "Doing" }] } } },
    ];
    const answers = [Response.json({ data: { repository: { issue: { projectItems: { nodes: items } } } } }), Response.json({ data: { updateProjectV2ItemFieldValue: {} } })];
    const { fetchImpl, requests } = fakeFetch({ "POST /graphql": () => answers.shift() as Response });
    const github = createGitHub(async () => "ghp_token", fetchImpl);

    expect(await github.moveToStatus(ACME_APP, 12, "In Progress")).toEqual(["Board"]);
    expect(requests).toHaveLength(2);
    expect((requests[0].body as { variables: unknown }).variables).toEqual({ owner: "acme", name: "app", number: 12 });
    expect((requests[1].body as { variables: unknown }).variables).toEqual({ project: "p1", item: "item1", field: "f1", option: "wip" });
  });

  it("reports GraphQL errors, which GitHub answers with HTTP 200", async () => {
    const { fetchImpl } = fakeFetch({ "POST /graphql": () => Response.json({ errors: [{ message: "Resource not accessible by integration" }] }) });
    const github = createGitHub(async () => "ghp_token", fetchImpl);

    await expect(github.moveToStatus(ACME_APP, 12, "In Progress")).rejects.toThrow("failed to read the projects of acme/app#12: Resource not accessible by integration");
  });
});

describe("statusTargets", () => {
  it("skips malformed items and matches the option name case-insensitively", () => {
    const items = [null, { id: 1 }, { id: "i", project: { id: "p", title: "T", field: { id: "f", options: [{ id: "o", name: "IN PROGRESS" }] } } }];
    expect(statusTargets(items, "In Progress")).toEqual([{ item: "i", project: "p", title: "T", field: "f", option: "o" }]);
    expect(statusTargets("nope", "In Progress")).toEqual([]);
  });
});
