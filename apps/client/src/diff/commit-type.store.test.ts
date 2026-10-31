import { describe, expect, it } from "vitest";
import { rememberedCommitType } from "./commit-type.store";

describe("rememberedCommitType", () => {
  it("prefers the session's own choice over its parent's", () => {
    expect(rememberedCommitType({ sub: "none", parent: "feat" }, "sub", "parent")).toBe("none");
  });

  it("falls back to the parent session's choice", () => {
    expect(rememberedCommitType({ parent: "fix" }, "sub", "parent")).toBe("fix");
  });

  it("is null when no session chose a type", () => {
    expect(rememberedCommitType({}, "sub", null)).toBeNull();
  });
});
