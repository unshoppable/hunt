import { describe, expect, it } from "vitest";
import { ownContent } from "./ownChanges";

const isOwn = (sessionId: string) => sessionId === "own";

describe("ownContent", () => {
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
