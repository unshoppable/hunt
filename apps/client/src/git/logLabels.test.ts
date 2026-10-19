import { describe, expect, it } from "vitest";
import { logLabels as labels, parseDecoration, shortRefName, type LogLabel } from "./logLabels";

const logLabels = (decorations: string[], head: string | null, local: string[] = []): LogLabel[] => labels(decorations, head, new Set(local));

describe("parseDecoration", () => {
  it("reads the kinds git log --decorate prints", () => {
    expect(parseDecoration("HEAD -> master")).toEqual({ kind: "head", name: "master" });
    expect(parseDecoration("HEAD")).toEqual({ kind: "head", name: "HEAD" });
    expect(parseDecoration("tag: v1.0")).toEqual({ kind: "tag", name: "v1.0" });
    expect(parseDecoration("origin/master")).toEqual({ kind: "remote", name: "origin/master" });
    expect(parseDecoration("master")).toEqual({ kind: "local", name: "master" });
  });

  it("reads a slashed name as local when the local branches list it", () => {
    expect(parseDecoration("feat/x")).toEqual({ kind: "remote", name: "feat/x" });
    expect(parseDecoration("feat/x", new Set(["feat/x"]))).toEqual({ kind: "local", name: "feat/x" });
  });
});

describe("shortRefName", () => {
  it("keeps the last two segments of a long name", () => {
    expect(shortRefName("master")).toBe("master");
    expect(shortRefName("origin/master")).toBe("origin/master");
    expect(shortRefName("feat/general/hunt-services")).toBe("…/general/hunt-services");
    expect(shortRefName("origin/feature/general/translated")).toBe("…/general/translated");
  });
});

describe("logLabels", () => {
  it("merges a local branch with its remote branches into one label and marks the checked-out one", () => {
    expect(logLabels(["HEAD -> master", "origin/master"], "master")).toEqual([{ kind: "branch", text: "origin & master", title: "master, origin/master", isHead: true }]);
    expect(logLabels(["master", "origin/master", "upstream/master"], "other")).toEqual([
      { kind: "branch", text: "origin & upstream & master", title: "master, origin/master, upstream/master", isHead: false },
    ]);
  });

  it("puts the checked-out branch first, then local, then remote-only branches, and shortens long names", () => {
    expect(logLabels(["origin/feature/general/x", "feature/general/x", "feat/general/y"], "feat/general/y", ["feature/general/x", "feat/general/y"])).toEqual([
      { kind: "branch", text: "…/general/y", title: "feat/general/y", isHead: true },
      { kind: "branch", text: "origin & …/general/x", title: "feature/general/x, origin/feature/general/x", isHead: false },
    ]);
    expect(logLabels(["origin/feat/a", "b"], null)).toEqual([
      { kind: "branch", text: "b", title: "b", isHead: false },
      { kind: "branch", text: "…/feat/a", title: "origin/feat/a", isHead: false },
    ]);
  });

  it("collapses the branches beyond the second into +n with their names as title", () => {
    expect(logLabels(["a", "b", "c", "origin/d"], null)).toEqual([
      { kind: "branch", text: "a", title: "a", isHead: false },
      { kind: "branch", text: "b", title: "b", isHead: false },
      { kind: "more", text: "+2", title: "c, origin/d" },
    ]);
  });

  it("collapses tags into one label: the name of a single tag, the count of several", () => {
    expect(logLabels(["tag: v1.0"], null)).toEqual([{ kind: "tags", text: "v1.0", title: "v1.0" }]);
    expect(logLabels(["tag: app@1.0", "master", "tag: lib@2.0"], null)).toEqual([
      { kind: "branch", text: "master", title: "master", isHead: false },
      { kind: "tags", text: "2", title: "app@1.0, lib@2.0" },
    ]);
  });

  it("labels a detached HEAD", () => {
    expect(logLabels(["HEAD", "tag: v1"], "HEAD")).toEqual([
      { kind: "branch", text: "HEAD", title: "HEAD", isHead: true },
      { kind: "tags", text: "v1", title: "v1" },
    ]);
  });
});
