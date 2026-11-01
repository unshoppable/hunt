import { describe, expect, it } from "vitest";
import { isInsideFolder, outermostPaths, renamedPath } from "./path.utils";

describe("isInsideFolder", () => {
  it("matches paths below the folder, not the folder itself or a sibling with the same prefix", () => {
    expect(isInsideFolder(".claude/skills/weq/CLAUDE.md", ".claude/skills/weq")).toBe(true);
    expect(isInsideFolder(".claude/skills/weq", ".claude/skills/weq")).toBe(false);
    expect(isInsideFolder(".claude/skills/weq2/CLAUDE.md", ".claude/skills/weq")).toBe(false);
    expect(isInsideFolder("CLAUDE.md", "")).toBe(true);
  });
});

describe("outermostPaths", () => {
  it("drops paths inside another of them and keeps the order", () => {
    expect(outermostPaths(["src/b.ts", "src", "src/app/main.ts", "README.md", "srcs/a.ts"])).toEqual(["src", "README.md", "srcs/a.ts"]);
    expect(outermostPaths(["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
  });
});

describe("renamedPath", () => {
  it("moves the renamed path and everything below it, and leaves other paths alone", () => {
    expect(renamedPath("src/domain", "src/domain", "src/model")).toBe("src/model");
    expect(renamedPath("src/domain/user/user.ts", "src/domain", "src/model")).toBe("src/model/user/user.ts");
    expect(renamedPath("src/domains/a.ts", "src/domain", "src/model")).toBe("src/domains/a.ts");
    expect(renamedPath("README.md", "src/domain", "src/model")).toBe("README.md");
  });
});
