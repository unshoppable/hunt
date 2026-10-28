import { describe, expect, it } from "vitest";
import { IssueReference } from "./issue-reference.value-object.ts";
import { Repository } from "./repository.value-object.ts";

const REPOSITORY = { owner: "unshoppable", name: "app-framework" };

describe("IssueReference", () => {
  it("rejects the number 0", () => {
    expect(() => new IssueReference({ repository: REPOSITORY, number: 0 })).toThrow(/positive integer/);
  });

  it("rejects a negative number", () => {
    expect(() => new IssueReference({ repository: REPOSITORY, number: -3 })).toThrow(/positive integer/);
  });

  it("rejects a number that is no integer", () => {
    expect(() => new IssueReference({ repository: REPOSITORY, number: 1.5 })).toThrow();
  });

  it("rejects a repository hunt-ctl does not accept", () => {
    expect(() => new IssueReference({ repository: { owner: "unshoppable", name: ".github" }, number: 3 })).toThrow(/starts with no dot/);
  });

  it("reads the repository and number of an issue URL", () => {
    const issue = IssueReference.fromUrl("https://github.com/unshoppable/app-framework/issues/527");
    expect(issue?.repository.isEqualTo(new Repository(REPOSITORY))).toBe(true);
    expect(issue?.number).toBe(527);
  });

  it("reads a pull request URL with a path, fragment or query after the number, and plain http", () => {
    expect(IssueReference.fromUrl("https://github.com/a-b/c.d/pull/12/files?x=1")?.toJSON()).toEqual({ repository: new Repository({ owner: "a-b", name: "c.d" }), number: 12 });
    expect(IssueReference.fromUrl("https://github.com/unshoppable/app-framework/pull/1468#issuecomment-1")?.number).toBe(1468);
    expect(IssueReference.fromUrl("http://github.com/unshoppable/app-framework/issues/7")?.number).toBe(7);
  });

  it("is null for a number with trailing characters, a repository URL, another host and a URL with an invalid repository or number", () => {
    const rejected = [
      "https://github.com/unshoppable/app-framework/issues/527x",
      "https://github.com/unshoppable/app-framework",
      "https://github.com/unshoppable/app-framework/discussions/5",
      "https://gitlab.com/unshoppable/app-framework/issues/5",
      "https://github.com/unshoppable/.github/issues/5",
      "https://github.com/unshoppable/app-framework/issues/0",
      "https://github.com/unshoppable/app-framework/issues/5 and more",
    ];
    expect(rejected.filter((url) => IssueReference.fromUrl(url))).toEqual([]);
  });

  it("reads the URL a prompt line starts with and nothing that comes later", () => {
    expect(IssueReference.fromPromptLine(" https://github.com/unshoppable/app-framework/issues/527 please fix")?.number).toBe(527);
    expect(IssueReference.fromPromptLine("fix https://github.com/unshoppable/app-framework/issues/527")).toBeNull();
    expect(IssueReference.fromPromptLine("")).toBeNull();
  });

  it("labels the issue by its number", () => {
    expect(new IssueReference({ repository: REPOSITORY, number: 527 }).label).toBe("#527");
  });

  it("serializes with the repository nested and compares by value", () => {
    const issue = new IssueReference({ repository: REPOSITORY, number: 527 });
    const stored = JSON.parse(JSON.stringify(issue));
    expect(stored).toEqual({ repository: REPOSITORY, number: 527 });
    expect(new IssueReference(stored).isEqualTo(issue)).toBe(true);
    expect(new IssueReference({ ...stored, number: 528 }).isEqualTo(issue)).toBe(false);
  });
});
