import { describe, expect, it } from "vitest";
import { storedSession } from "../sessions/hunt.store.fixtures";
import type { PullRequestRef } from "../sessions/session.types";
import { changeListComparison, chosenDiffBase, scopedChangedFiles, sharesWorktree, shownChangeListTab, withoutHiddenFiles } from "./changelist-view.utils";

const file = (path: string, touchedBy: string[]) => ({ path, status: "M", touchedBy });

describe("shownChangeListTab", () => {
  it("opens a pull request review on the review tab and every other session on the changelist", () => {
    expect(shownChangeListTab(undefined, true)).toBe("review");
    expect(shownChangeListTab(undefined, false)).toBe("changelist");
  });

  it("keeps the stored tab unless it is the review tab of a session without a pull request", () => {
    expect(shownChangeListTab("shelf", true)).toBe("shelf");
    expect(shownChangeListTab("review", true)).toBe("review");
    expect(shownChangeListTab("review", false)).toBe("changelist");
  });
});

describe("changeListComparison", () => {
  it("compares the review tab against the diff base and the other tabs against HEAD", () => {
    expect(changeListComparison("review", null)).toBe("diffBase");
    expect(changeListComparison("changelist", null)).toBe("head");
    expect(changeListComparison("shelf", null)).toBe("head");
  });

  it("compares the changelist tab against a commit the user chose", () => {
    expect(changeListComparison("changelist", "abc123")).toBe("diffBase");
    expect(changeListComparison("shelf", "abc123")).toBe("head");
  });
});

describe("chosenDiffBase", () => {
  it("is the diff base of a session that reviews no pull request", () => {
    expect(chosenDiffBase({ diffBase: "abc123", pullRequest: null })).toBe("abc123");
    expect(chosenDiffBase({ diffBase: null, pullRequest: null })).toBeNull();
    expect(chosenDiffBase(undefined)).toBeNull();
  });

  it("is null for a pull request review, whose diff base is the merge base", () => {
    expect(chosenDiffBase({ diffBase: "abc123", pullRequest: { number: 7 } as PullRequestRef })).toBeNull();
  });
});

describe("sharesWorktree", () => {
  it("is true for the repository's own checkout and for a worktree another session works in", () => {
    const session = storedSession("s1", "One");
    const sub = { ...storedSession("s2", "Two"), worktreePath: session.worktreePath, parentId: "s1" };
    expect(sharesWorktree([session], { ...session, workspace: "checkout" })).toBe(true);
    expect(sharesWorktree([session, sub], session)).toBe(true);
  });

  it("is false for a worktree of the session alone", () => {
    const session = storedSession("s1", "One");
    expect(sharesWorktree([session, storedSession("s2", "Two")], session)).toBe(false);
    expect(sharesWorktree([session], undefined)).toBe(false);
  });
});

describe("scopedChangedFiles", () => {
  const files = [file("own.ts", ["s1"]), file("other.ts", ["s2"])];

  it("keeps the files of the scope", () => {
    expect(scopedChangedFiles(files, { sessionId: "s1", parentId: null, workspace: "worktree", scope: "own" }).map((entry) => entry.path)).toEqual(["own.ts"]);
  });

  it("keeps every file without a scope", () => {
    expect(scopedChangedFiles(files, { sessionId: "s1", parentId: null, workspace: "worktree", scope: null })).toBe(files);
  });
});

describe("withoutHiddenFiles", () => {
  const files = [file("src/a.ts", []), file("src/a.spec.ts", []), file("README.md", [])];

  it("drops the files matching a hidden glob", () => {
    expect(withoutHiddenFiles(files, "*.spec.ts, *.md").map((entry) => entry.path)).toEqual(["src/a.ts"]);
  });

  it("keeps every file without globs", () => {
    expect(withoutHiddenFiles(files, "  ")).toBe(files);
  });
});
