import { describe, expect, it } from "vitest";
import { ReviewVerdict } from "./review-verdict.value-object.ts";

describe("ReviewVerdict", () => {
  it("takes the newest comment with a verdict marker and ignores broken ones", () => {
    const comments = [
      { body: '<!-- claude-pr-review -->\nold\n<!-- claude-pr-review:verdict {"headSha":"old","blocking":2,"findings":3} -->' },
      { body: "a human comment" },
      { body: "<!-- claude-pr-review:verdict {broken} -->" },
      { body: '<!-- claude-pr-review -->\nnew\n<!-- claude-pr-review:verdict {"headSha":"new","blocking":0,"findings":1} -->' },
    ];
    expect(ReviewVerdict.latestIn(comments)).toMatchObject({ headSha: "new", blocking: 0, findings: 1 });
    expect(ReviewVerdict.latestIn(comments)?.text).toBe("new");
    expect(ReviewVerdict.latestIn([{ body: "nothing" }])).toBeNull();
    expect(ReviewVerdict.latestIn([{ body: '<!-- claude-pr-review:verdict {"headSha":"x"} -->' }])).toBeNull();
  });

  it("counts all findings as the blocking ones when the marker names none or a broken number", () => {
    expect(ReviewVerdict.latestIn([{ body: '<!-- claude-pr-review:verdict {"headSha":"x","blocking":2} -->' }])?.findings).toBe(2);
    expect(ReviewVerdict.latestIn([{ body: '<!-- claude-pr-review:verdict {"headSha":"x","blocking":2,"findings":"3"} -->' }])?.findings).toBe(2);
  });

  it("judges one head and knows whether it blocks", () => {
    const verdict = new ReviewVerdict({ headSha: "a".repeat(40), blocking: 1, findings: 2, body: "" });
    expect(verdict.isFor("a".repeat(40))).toBe(true);
    expect(verdict.isFor("b".repeat(40))).toBe(false);
    expect(verdict.hasBlockingFindings).toBe(true);
    expect(() => new ReviewVerdict({ headSha: "x", blocking: -1, findings: 0, body: "" })).toThrow();
  });
});
