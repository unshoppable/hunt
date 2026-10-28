import { describe, expect, it } from "vitest";
import type { GitRef } from "./git.types";
import { buildRefTree, groupPaths } from "./ref-groups.utils";

const ref = (name: string, kind: GitRef["kind"] = "local"): GitRef => ({ name, kind, target: "0".repeat(40), upstream: null, ahead: 0, behind: 0 });

describe("buildRefTree", () => {
  it("groups local branches by their slashes with the checked-out branch first", () => {
    const [local] = buildRefTree([ref("feat/general/b"), ref("feat/general/a"), ref("working-old"), ref("master")], "master");
    expect(local).toMatchObject({ name: "Local", path: "local", count: 4 });
    expect(local.children.map((node) => node.name)).toEqual(["feat", "master", "working-old"]);
    const [feat] = local.children;
    if (feat.kind !== "group") throw new Error("expected group");
    expect(feat.path).toBe("local/feat");
    expect(feat.children.map((node) => node.name)).toEqual(["general"]);
    const [general] = feat.children;
    if (general.kind !== "group") throw new Error("expected group");
    expect(general.children.map((node) => node.name)).toEqual(["a", "b"]);
    expect(general.children[0]).toMatchObject({ kind: "ref", path: "local/feat/general/a", ref: { name: "feat/general/a" } });
  });

  it("nests remote branches under their remote and lists tags last", () => {
    const tree = buildRefTree([ref("v1.0", "tag"), ref("origin/master", "remote"), ref("origin/feat/x", "remote")], "HEAD");
    expect(tree.map((node) => node.name)).toEqual(["Remote", "Tags"]);
    const [remote, tags] = tree;
    expect(remote.children.map((node) => node.name)).toEqual(["origin"]);
    const [origin] = remote.children;
    if (origin.kind !== "group") throw new Error("expected group");
    expect(origin.children.map((node) => node.name)).toEqual(["feat", "master"]);
    expect(tags.children[0]).toMatchObject({ kind: "ref", name: "v1.0", path: "tags/v1.0" });
  });

  it("leaves out empty groups", () => {
    expect(buildRefTree([ref("master")], "master").map((node) => node.name)).toEqual(["Local"]);
  });
});

describe("groupPaths", () => {
  it("lists every group at any depth", () => {
    const tree = buildRefTree([ref("feat/general/a"), ref("master"), ref("origin/master", "remote")], "master");
    expect(groupPaths(tree)).toEqual(["local", "local/feat", "local/feat/general", "remote", "remote/origin"]);
  });
});
