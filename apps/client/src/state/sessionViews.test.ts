import { describe, expect, it } from "vitest";
import { SESSION_VIEW_LIMIT, withSessionView, type SessionView } from "./sessionViews";

describe("withSessionView", () => {
  it("merges the change into the session's view and moves it to the end", () => {
    const views: Record<string, SessionView> = { first: { tab: "git", diffPath: "a.ts" }, second: { tab: "diff" } };
    const result = withSessionView(views, "first", { diffPath: "b.ts" });
    expect(Object.keys(result)).toEqual(["second", "first"]);
    expect(result.first).toEqual({ tab: "git", diffPath: "b.ts" });
  });

  it("drops the least recently changed views beyond the limit", () => {
    const views = Object.fromEntries(Array.from({ length: SESSION_VIEW_LIMIT }, (_, index) => [`session-${index}`, { tab: "diff" as const }]));
    const result = withSessionView(views, "new", { tab: "editor" });
    expect(Object.keys(result)).toHaveLength(SESSION_VIEW_LIMIT);
    expect(result["session-0"]).toBeUndefined();
    expect(result.new).toEqual({ tab: "editor" });
  });
});
