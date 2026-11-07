import { describe, expect, it } from "vitest";
import { storedSession } from "../sessions/hunt.store.fixtures";
import { changeListComparison, scopedChangedFiles, sharesWorktree, shownChangeListTab, withoutHiddenFiles } from "./changelist-view.utils";

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
    expect(changeListComparison("review")).toBe("diffBase");
    expect(changeListComparison("changelist")).toBe("head");
    expect(changeListComparison("shelf")).toBe("head");
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
