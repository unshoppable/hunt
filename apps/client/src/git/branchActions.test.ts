import { describe, expect, it } from "vitest";
import type { GitRef } from "../ipc/types";
import { branchActions, localBranchesWithoutOrigin, originBranchName } from "./branchActions";

const ref = (name: string, kind: GitRef["kind"], upstream: string | null = null): GitRef => ({ name, kind, target: "0".repeat(40), upstream, ahead: 0, behind: 0 });
const session = { head: "feat/general/x", pushes: { branch: "feat/general/x", target: "master" }, isRemoteSession: false, isPollerSession: false };

const labels = (actions: ReturnType<typeof branchActions>) => actions.map((action) => `${action.label}${action.disabledReason ? ` (${action.disabledReason})` : ""}`);

describe("branchActions", () => {
  it("offers the session branch an update from and a push to the branch its push lands on, and no delete", () => {
    expect(labels(branchActions(ref("feat/general/x", "local"), session))).toEqual([
      "Rebase 'feat/general/x' onto 'feat/general/x' (The branch is checked out)",
      "Merge 'feat/general/x' into 'feat/general/x' (The branch is checked out)",
      "Update from 'origin/master'",
      "Push to 'origin/master'",
      "Change push target…",
      "Rename…",
      "Delete (The branch is checked out)",
    ]);
  });

  it("lets only a session that pushes from this Mac change its push target", () => {
    const poller = { head: "fix/general/123-x", pushes: { branch: "fix/general/123-x", target: "fix/general/123-x" }, isRemoteSession: true, isPollerSession: true };
    expect(labels(branchActions(ref("fix/general/123-x", "local"), poller))).toContain("Change push target… (A poller session pushes its own branch)");
    expect(labels(branchActions(ref("master", "local"), session))).not.toContain("Change push target…");
    const ownBranch = { ...session, pushes: { branch: "feat/general/x", target: "feat/general/x" }, isRemoteSession: true };
    expect(labels(branchActions(ref("feat/general/x", "local"), ownBranch))).toContain("Change push target…");
  });

  it("rebases onto, merges, fast-forwards, pushes, renames and deletes another local branch", () => {
    const actions = branchActions(ref("master", "local", "origin/master"), session);
    expect(labels(actions)).toEqual([
      "Rebase 'feat/general/x' onto 'master'",
      "Merge 'master' into 'feat/general/x'",
      "Update from 'origin/master'",
      "Push to 'origin/master'",
      "Rename…",
      "Delete",
    ]);
    expect(actions.map((action) => action.kind)).toEqual(["rebase", "merge", "update", "pushBranch", "rename", "delete"]);
    expect(actions.filter((action) => action.startsGroup).map((action) => action.kind)).toEqual(["update", "rename"]);
    expect(actions.filter((action) => action.isDanger).map((action) => action.kind)).toEqual(["delete"]);
  });

  it("cannot update a local branch without an upstream", () => {
    expect(labels(branchActions(ref("working-old", "local"), session))).toContain("Update (The branch has no upstream)");
  });

  it("fetches and deletes a remote branch of origin, and only rebases onto or merges one of another remote", () => {
    expect(labels(branchActions(ref("origin/master", "remote"), session))).toEqual([
      "Rebase 'feat/general/x' onto 'origin/master'",
      "Merge 'origin/master' into 'feat/general/x'",
      "Fetch 'origin/master'",
      "Delete on origin",
    ]);
    expect(labels(branchActions(ref("fork/master", "remote"), session))).toEqual([
      "Rebase 'feat/general/x' onto 'fork/master'",
      "Merge 'fork/master' into 'feat/general/x'",
      "Fetch 'fork/master' (Only branches of origin)",
      "Delete on origin (Only branches of origin)",
    ]);
  });

  it("neither rebases nor merges with a detached HEAD", () => {
    const actions = branchActions(ref("master", "local"), { ...session, head: "HEAD" });
    expect(actions.slice(0, 2).map((action) => action.disabledReason)).toEqual(["No branch is checked out", "No branch is checked out"]);
  });

  it("does not rename the branch of a remote session, whose VM has it under that name", () => {
    const actions = branchActions(ref("feat/general/x", "local"), { ...session, isRemoteSession: true });
    expect(actions.find((action) => action.kind === "rename")?.disabledReason).toBe("The session's VM has the branch under this name");
    expect(branchActions(ref("master", "local"), { ...session, isRemoteSession: true }).find((action) => action.kind === "rename")?.disabledReason).toBeNull();
  });

  it("gives a tag no menu", () => {
    expect(branchActions(ref("v1.0.0", "tag"), session)).toEqual([]);
  });

  it("names the branch of origin a remote branch is", () => {
    expect(originBranchName("origin/feat/general/x")).toBe("feat/general/x");
    expect(originBranchName("fork/master")).toBeNull();
  });
});

describe("localBranchesWithoutOrigin", () => {
  it("lists the local branches origin lacks, without the kept ones, sorted", () => {
    const refs = [ref("master", "local"), ref("zed", "local"), ref("feat/b", "local"), ref("feat/a", "local"), ref("origin/master", "remote"), ref("origin/feat/a", "remote"), ref("v1", "tag")];
    expect(localBranchesWithoutOrigin(refs, new Set(["master"]))).toEqual(["feat/b", "zed"]);
    expect(localBranchesWithoutOrigin(refs, new Set(["master", "zed"]))).toEqual(["feat/b"]);
  });

  it("ignores branches on other remotes", () => {
    expect(localBranchesWithoutOrigin([ref("x", "local"), ref("upstream/x", "remote")], new Set())).toEqual(["x"]);
  });
});
