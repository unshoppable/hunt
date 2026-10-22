import { describe, expect, it } from "vitest";
import { ownView } from "./ownChanges";

const isOwn = (sessionId: string) => sessionId === "own";
const ownContent = (...args: Parameters<typeof ownView>) => ownView(...args).content;

describe("ownView content", () => {
  it("leaves out lines another session added and keeps the own ones", () => {
    const versions = [
      { sessionId: null, content: "a\nb\nc\n" },
      { sessionId: "other", content: "a\nOTHER\nb\nc\n" },
      { sessionId: "own", content: "a\nOTHER\nb\nc\nOWN\n" },
    ];
    expect(ownContent("a\nb\nc\n", versions, "a\nOTHER\nb\nc\nOWN\n", isOwn)).toBe("a\nb\nc\nOWN\n");
  });

  it("keeps lines another session deleted", () => {
    const versions = [
      { sessionId: null, content: "a\nb\nc\n" },
      { sessionId: "other", content: "a\nc\n" },
    ];
    expect(ownContent("a\nb\nc\n", versions, "a\nc\n", isOwn)).toBe("a\nb\nc\n");
  });

  it("drops lines the own session deleted, also when another session changed the rest", () => {
    const versions = [
      { sessionId: null, content: "a\nb\nc\n" },
      { sessionId: "own", content: "a\nc\n" },
      { sessionId: "other", content: "A\nc\n" },
    ];
    expect(ownContent("a\nb\nc\n", versions, "A\nc\n", isOwn)).toBe("a\nc\n");
  });

  it("shows the own version of a line another session rewrote afterwards", () => {
    const versions = [
      { sessionId: null, content: "a\n" },
      { sessionId: "own", content: "a\nmine\n" },
      { sessionId: "other", content: "a\ntheirs\n" },
    ];
    expect(ownContent("a\n", versions, "a\ntheirs\n", isOwn)).toBe("a\nmine\n");
  });

  it("counts changes outside the log as someone else's", () => {
    expect(ownContent("a\n", [], "a\nunknown\n", isOwn)).toBe("a\n");
    expect(ownContent("a\n", [{ sessionId: null, content: "a\nbefore\n" }], "a\nbefore\n", isOwn)).toBe("a\n");
  });

  it("handles a file the own session created and a last line without a break", () => {
    const versions = [
      { sessionId: null, content: null },
      { sessionId: "own", content: "x\ny" },
      { sessionId: "other", content: "x\ny\nz" },
    ];
    expect(ownContent(null, versions, "x\ny\nz", isOwn)).toBe("x\ny");
    expect(ownContent("x", [{ sessionId: null, content: "x" }, { sessionId: "own", content: "w\nx" }], "w\nx", isOwn)).toBe("w\nx");
  });
});

describe("ownView overwrites", () => {
  it("lists an own line another session rewrote afterwards with the line on disk", () => {
    const versions = [
      { sessionId: null, content: "a\nb\n" },
      { sessionId: "own", content: "a\nmine\n" },
      { sessionId: "other", content: "a\ntheirs\n" },
    ];
    expect(ownView("a\nb\n", versions, "a\ntheirs\n", isOwn).overwrites).toEqual([{ startLine: 2, endLine: 2, sessionIds: ["other"], diskLines: ["theirs"] }]);
  });

  it("lists nothing for the session whose change is on disk", () => {
    const versions = [
      { sessionId: null, content: "a\n" },
      { sessionId: "first", content: "b\n" },
      { sessionId: "own", content: "c\n" },
    ];
    expect(ownView("a\n", versions, "c\n", isOwn)).toEqual({ content: "a\nc\n", overwrites: [] });
  });

  it("joins adjacent overwritten lines and orders their sessions by the last change", () => {
    const versions = [
      { sessionId: null, content: "a\nz\n" },
      { sessionId: "own", content: "a\nx\ny\nz\n" },
      { sessionId: "second", content: "a\nX\ny\nz\n" },
      { sessionId: "third", content: "a\nX\nz\n" },
    ];
    expect(ownView("a\nz\n", versions, "a\nX\nz\n", isOwn).overwrites).toEqual([
      { startLine: 2, endLine: 3, sessionIds: ["second", "third"], diskLines: ["X"] },
    ]);
  });

  it("reports deleted lines without disk lines and changes outside tool calls without a session", () => {
    const deleted = [
      { sessionId: null, content: "a\n" },
      { sessionId: "own", content: "a\nmine\n" },
      { sessionId: "other", content: "a\n" },
    ];
    expect(ownView("a\n", deleted, "a\n", isOwn).overwrites).toEqual([{ startLine: 2, endLine: 2, sessionIds: ["other"], diskLines: [] }]);
    const edited = [
      { sessionId: null, content: "a\n" },
      { sessionId: "own", content: "a\nmine" },
    ];
    expect(ownView("a\n", edited, "a\nedited", isOwn).overwrites).toEqual([{ startLine: 2, endLine: 2, sessionIds: [null], diskLines: ["edited"] }]);
  });

  it("leaves base lines other sessions changed alone", () => {
    const versions = [
      { sessionId: null, content: "a\nb\n" },
      { sessionId: "other", content: "A\nb\n" },
      { sessionId: "own", content: "A\nb\nmine\n" },
    ];
    expect(ownView("a\nb\n", versions, "A\nb\nmine\n", isOwn).overwrites).toEqual([]);
  });
});
