import { describe, expect, it } from "vitest";
import type { Issue } from "./github.client.ts";
import { branchName, slugify } from "./session-branch.utils.ts";

function issue(number: number, title = `Issue ${number}`, labels = ["swf"]): Issue {
  return { number, title, body: "", author: "alice", createdAt: "2026-10-13T08:04:05Z", url: `https://github.com/acme/app/issues/${number}`, labels, state: "open", assignees: [] };
}

describe("branch names", () => {
  it("slugifies titles to at most 40 lowercase ASCII characters without dangling dashes", () => {
    expect(slugify("Fix login, then logout!")).toBe("fix-login-then-logout");
    expect(slugify("Übersetzung für Ärzte & Co.")).toBe("ubersetzung-fur-arzte-co");
    expect(slugify("  --Hello__World--  ")).toBe("hello-world");
    expect(slugify("A".repeat(30) + " " + "b".repeat(30))).toBe(`${"a".repeat(30)}-${"b".repeat(9)}`);
    expect(slugify(`${"a".repeat(39)} tail`)).toBe("a".repeat(39));
    expect(slugify("日本語")).toBe("");
  });

  it("names the branch feat/general/<issue>-<slug>, or feat/general/<issue> without a usable title", () => {
    expect(branchName(issue(12, "Fix login")).name).toBe("feat/general/12-fix-login");
    expect(branchName(issue(7, "!!!")).name).toBe("feat/general/7");
    expect(branchName(issue(8, "Add export", [])).name).toBe("feat/general/8-add-export");
  });

  it("names the branch of an issue labelled bug, in any case, fix/general/<issue>-<slug>", () => {
    expect(branchName(issue(12, "Fix login", ["swf", "bug"])).name).toBe("fix/general/12-fix-login");
    expect(branchName(issue(13, "Crash", ["Bug"])).name).toBe("fix/general/13-crash");
    expect(branchName(issue(14, "!!!", ["bug"])).name).toBe("fix/general/14");
    expect(branchName(issue(15, "Debug view", ["swf", "debug", "bugfix"])).name).toBe("feat/general/15-debug-view");
  });
});
