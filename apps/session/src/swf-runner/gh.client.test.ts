import { describe, expect, it } from "vitest";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import { GhClient } from "./gh.client.ts";

const REPO = Repository.fromSlug("acme/app");

/** A `gh` that records its calls and answers each with the next of `outputs`. */
function fakeGh(outputs: string[] = []) {
  const calls: { args: string[]; input?: string }[] = [];
  const client = new GhClient((args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    return Promise.resolve(outputs.shift() ?? "");
  });
  return { client, calls };
}

describe("GhClient", () => {
  it("reads the issue with its labels and comments as the prompts quote them, with ghost for a deleted author", async () => {
    const view = {
      number: 12,
      title: "Fix login",
      body: "The login fails.",
      author: { login: "alice" },
      createdAt: "2026-10-13T08:00:00Z",
      url: "https://github.com/acme/app/issues/12",
      labels: [{ name: "swf:plan" }, { name: "bug" }],
      comments: [
        { id: 1, author: { login: "bob" }, createdAt: "2026-10-13T09:00:00Z", body: "Also the logout." },
        { id: 2, author: null, createdAt: "2026-10-13T09:30:00Z", body: "Gone." },
      ],
    };
    const { client, calls } = fakeGh([JSON.stringify(view)]);
    expect(await client.issue(REPO, 12)).toEqual({
      issue: { number: 12, title: "Fix login", body: "The login fails.", author: "alice", createdAt: "2026-10-13T08:00:00Z", url: "https://github.com/acme/app/issues/12" },
      labels: ["swf:plan", "bug"],
      comments: [
        { author: "bob", createdAt: "2026-10-13T09:00:00Z", body: "Also the logout." },
        { author: "ghost", createdAt: "2026-10-13T09:30:00Z", body: "Gone." },
      ],
    });
    expect(calls).toEqual([{ args: ["issue", "view", "12", "--repo", "acme/app", "--json", "number,title,body,author,createdAt,url,labels,comments"] }]);
  });

  it("reads the labels alone and refuses output that is no issue", async () => {
    const { client, calls } = fakeGh([JSON.stringify({ labels: [{ name: "swf:question" }] }), "gh: not found"]);
    expect(await client.labels(REPO, 12)).toEqual(["swf:question"]);
    expect(calls[0]).toEqual({ args: ["issue", "view", "12", "--repo", "acme/app", "--json", "labels"] });
    await expect(client.issue(REPO, 12)).rejects.toThrow("gh issue view 12 gave no issue: gh: not found");
  });

  it("comments through stdin, edits a comment through the API and changes labels in one edit", async () => {
    const { client, calls } = fakeGh();
    await client.comment(REPO, 12, "## Plan\n");
    await client.editComment(REPO, 1000, "**Hunt:** step `implement`");
    await client.editLabels(REPO, 12, ["swf:implement"], ["swf:plan", "swf:question"]);
    await client.editLabels(REPO, 12, [], []);
    expect(calls).toEqual([
      { args: ["issue", "comment", "12", "--repo", "acme/app", "--body-file", "-"], input: "## Plan\n" },
      { args: ["api", "--method", "PATCH", "repos/acme/app/issues/comments/1000", "--input", "-"], input: JSON.stringify({ body: "**Hunt:** step `implement`" }) },
      { args: ["issue", "edit", "12", "--repo", "acme/app", "--add-label", "swf:implement", "--remove-label", "swf:plan", "--remove-label", "swf:question"] },
    ]);
  });
});
