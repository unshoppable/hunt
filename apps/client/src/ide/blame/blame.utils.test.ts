import { describe, expect, it } from "vitest";
import type { BlameCommit } from "./blame.types";
import { ANNOTATION_WIDTH, annotationOf, blameHover, blameRuns, lineCommits, withEdits } from "./blame.utils";

function commit(overrides: Partial<BlameCommit> = {}): BlameCommit {
  return { id: "a".repeat(40), author: "Jane Doe", authorEmail: "jane@example.com", authoredAt: "2026-11-13T12:00:00Z", subject: "feat: x", ...overrides };
}

describe("lineCommits", () => {
  it("resolves every line's index and keeps uncommitted lines null", () => {
    const first = commit();
    const second = commit({ id: "b".repeat(40) });
    expect(lineCommits({ commits: [first, second], lines: [1, null, 0, 7] })).toEqual([second, null, first, null]);
  });
});

describe("annotationOf", () => {
  it("shows the day and the author at a fixed width", () => {
    expect(annotationOf(commit())).toBe("2026-11-13 Jane Doe        ");
    expect(annotationOf(commit())).toHaveLength(ANNOTATION_WIDTH);
  });

  it("cuts a long author name", () => {
    const annotation = annotationOf(commit({ author: "Maximilian von Hohenzollern" }));
    expect(annotation).toBe("2026-11-13 Maximilian von …");
    expect(annotation).toHaveLength(ANNOTATION_WIDTH);
  });
});

describe("blameRuns", () => {
  it("groups neighbouring lines of one commit and skips uncommitted lines", () => {
    const first = commit();
    const second = commit({ id: "b".repeat(40) });
    expect(blameRuns([first, first, null, first, second, second])).toEqual([
      { startLine: 1, endLine: 2, commit: first },
      { startLine: 4, endLine: 4, commit: first },
      { startLine: 5, endLine: 6, commit: second },
    ]);
  });
});

describe("withEdits", () => {
  const first = commit();
  const second = commit({ id: "b".repeat(40) });
  const third = commit({ id: "c".repeat(40) });

  it("clears an edited line and keeps the others", () => {
    expect(withEdits([first, second, third], [{ startLine: 2, endLine: 2, insertedLineBreaks: 0 }])).toEqual([first, null, third]);
  });

  it("shifts the lines below added and removed lines", () => {
    expect(withEdits([first, second, third], [{ startLine: 1, endLine: 1, insertedLineBreaks: 2 }])).toEqual([null, null, null, second, third]);
    expect(withEdits([first, second, third], [{ startLine: 1, endLine: 2, insertedLineBreaks: 0 }])).toEqual([null, third]);
  });

  it("applies several edits of one change whatever their order", () => {
    const edits = [
      { startLine: 1, endLine: 1, insertedLineBreaks: 1 },
      { startLine: 3, endLine: 3, insertedLineBreaks: 0 },
    ];
    expect(withEdits([first, second, third], edits)).toEqual([null, null, second, null]);
    expect(withEdits([first, second, third], [...edits].reverse())).toEqual([null, null, second, null]);
  });
});

describe("blameHover", () => {
  it("escapes Markdown of the subject and the author", () => {
    expect(blameHover(commit({ subject: "fix: *x*", author: "J_D" }))).toBe(`**fix: \\*x\\***\n\nJ\\_D · 2026-11-13 · \`aaaaaaaa\``);
  });
});
