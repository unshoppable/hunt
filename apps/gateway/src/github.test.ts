import { describe, expect, it } from "vitest";
import { createGitHub, nextPageUrl, parseIssues } from "./github.ts";

const API = "https://api.github.com";

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
  it("leaves pull requests out, takes the label names and fills in missing fields", () => {
    const issues = parseIssues([
      {
        number: 3,
        title: "Fix login",
        body: null,
        user: { login: "alice" },
        created_at: "2026-10-13T08:00:00Z",
        html_url: "https://github.com/acme/app/issues/3",
        labels: [{ id: 1, name: "swf" }, "bug", { id: 2 }, null],
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
      },
      { number: 5, title: "Deleted author", body: "", author: "ghost", createdAt: "", url: "", labels: [] },
    ]);
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

    const issues = await createGitHub("ghp_token", fetchImpl).openIssues("acme/app", "swf");
    expect(issues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(requests[0].headers.get("Authorization")).toBe("Bearer ghp_token");
    expect(requests[0].headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
  });

  it("refuses to send the token to a host other than GitHub's API", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/acme/app/issues/1/comments?per_page=100": () => Response.json([], { headers: { Link: '<https://evil.example.com/x>; rel="next"' } }),
    });
    await expect(createGitHub("ghp_token", fetchImpl).comments("acme/app", 1)).rejects.toThrow("refused to call https://evil.example.com/x with the GitHub token");
  });

  it("removes a label, reporting whether the issue had it, and adds labels and comments", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "DELETE /repos/acme/app/issues/3/labels/swf": () => Response.json([]),
      "DELETE /repos/acme/app/issues/4/labels/swf": () => Response.json({ message: "Label does not exist" }, { status: 404 }),
      "DELETE /repos/acme/app/issues/5/labels/swf": () => new Response("forbidden", { status: 403 }),
      "POST /repos/acme/app/issues/3/labels": () => Response.json([]),
      "POST /repos/acme/app/issues/3/comments": () => Response.json({ id: 1 }, { status: 201 }),
    });
    const github = createGitHub("ghp_token", fetchImpl);

    expect(await github.removeLabel("acme/app", 3, "swf")).toBe(true);
    expect(await github.removeLabel("acme/app", 4, "swf")).toBe(false);
    await expect(github.removeLabel("acme/app", 5, "swf")).rejects.toThrow("failed to remove the label swf from acme/app#5: HTTP 403 forbidden");
    await github.addLabels("acme/app", 3, ["swf:running"]);
    await github.comment("acme/app", 3, "Hunt started a session");
    expect(requests.slice(-2).map((request) => request.body)).toEqual([{ labels: ["swf:running"] }, { body: "Hunt started a session" }]);
  });

  it("creates a missing label and accepts one created meanwhile", async () => {
    const { fetchImpl, requests } = fakeFetch({
      "GET /repos/acme/app/labels/swf%3Arunning": () => new Response("", { status: 404 }),
      "GET /repos/acme/app/labels/swf%3Adone": () => new Response("", { status: 404 }),
      "GET /repos/acme/app/labels/swf%3Afailed": () => Response.json({ name: "swf:failed" }),
      "POST /repos/acme/app/labels": () => Response.json({ message: "Validation Failed" }, { status: 422 }),
    });
    const github = createGitHub("ghp_token", fetchImpl);
    const label = { name: "swf:running", color: "fbca04", description: "Hunt works on this issue" };

    await github.ensureLabel("acme/app", label);
    await github.ensureLabel("acme/app", { ...label, name: "swf:done" });
    await github.ensureLabel("acme/app", { ...label, name: "swf:failed" });
    expect(requests.map((request) => request.key)).toEqual([
      "GET /repos/acme/app/labels/swf%3Arunning",
      "POST /repos/acme/app/labels",
      "GET /repos/acme/app/labels/swf%3Adone",
      "POST /repos/acme/app/labels",
      "GET /repos/acme/app/labels/swf%3Afailed",
    ]);
    expect(requests[1].body).toEqual(label);
  });
});
