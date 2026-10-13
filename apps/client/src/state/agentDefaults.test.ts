import { describe, expect, it } from "vitest";
import { RECENT_REPO_LIMIT, withRecentRepoPath } from "./agentDefaults";

describe("withRecentRepoPath", () => {
  it("puts the repository first and drops its earlier entry", () => {
    expect(withRecentRepoPath(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
  });

  it("keeps the list at the limit", () => {
    const paths = Array.from({ length: RECENT_REPO_LIMIT }, (_, index) => `/repo-${index}`);
    const result = withRecentRepoPath(paths, "/new");
    expect(result).toHaveLength(RECENT_REPO_LIMIT);
    expect(result[0]).toBe("/new");
    expect(result).not.toContain(`/repo-${RECENT_REPO_LIMIT - 1}`);
  });
});
