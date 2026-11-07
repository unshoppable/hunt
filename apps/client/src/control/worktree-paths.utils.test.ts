import { describe, expect, it } from "vitest";
import { storedSession } from "../sessions/hunt.store.fixtures";
import { localWorktreePaths, NO_LOCAL_WORKTREE, unknownPaths } from "./worktree-paths.utils";

describe("localWorktreePaths", () => {
  const session = storedSession("s1", "Local");

  it("makes the paths relative to the worktree", () => {
    expect(localWorktreePaths(session, ["/worktrees/s1/src/a.ts", "/worktrees/s1/b.ts"])).toEqual(["src/a.ts", "b.ts"]);
  });

  it("rejects a path outside the worktree", () => {
    expect(() => localWorktreePaths(session, ["/elsewhere/a.ts"])).toThrow("lies outside the session's worktree");
  });

  it("rejects paths without a local worktree, but not an empty list", () => {
    const remote = { ...session, hasLocalWorktree: false };
    expect(() => localWorktreePaths(remote, ["/worktrees/s1/a.ts"])).toThrow(NO_LOCAL_WORKTREE);
    expect(localWorktreePaths(remote, [])).toEqual([]);
  });
});

describe("unknownPaths", () => {
  it("lists the paths the known ones lack, in their order", () => {
    expect(unknownPaths(["c.ts", "a.ts", "b.ts"], ["a.ts"])).toEqual(["c.ts", "b.ts"]);
    expect(unknownPaths([], ["a.ts"])).toEqual([]);
  });
});
