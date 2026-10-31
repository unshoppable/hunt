import { describe, expect, it } from "vitest";
import { commitTypeOf, withCommitType } from "./commit-type.utils";

describe("commitTypeOf", () => {
  it("reads a known type prefix", () => {
    expect(commitTypeOf("fix: crash on start")).toBe("fix");
  });

  it("reports none for a message without a known prefix", () => {
    expect(commitTypeOf("update readme")).toBe("none");
    expect(commitTypeOf("wip: update readme")).toBe("none");
  });
});

describe("withCommitType", () => {
  it("prefixes a message without a prefix", () => {
    expect(withCommitType("update readme", "docs")).toBe("docs: update readme");
  });

  it("replaces an existing prefix", () => {
    expect(withCommitType("feat: update", "fix")).toBe("fix: update");
  });

  it("removes the prefix for none", () => {
    expect(withCommitType("feat: update", "none")).toBe("update");
  });

  it("starts an empty message with the prefix", () => {
    expect(withCommitType("", "feat")).toBe("feat: ");
  });
});
