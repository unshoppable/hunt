import { describe, expect, it } from "vitest";
import { createFileIndex, resolveFileReference } from "./fileLinks";

const BASE = "/Users/me/worktrees/app-1";
const INDEX = createFileIndex([
  "CLAUDE.md",
  "apps/med/CLAUDE.md",
  "apps/med/backend/src/app/api/content/summary.service.ts",
  "apps/med/backend/src/app/api/content/index.ts",
  "libs/shared/backend/src/index.ts",
  "libs/shared/backend/src/lib/utilities/dtos/dto-utility.types.ts",
  "Dockerfile",
]);

describe("resolveFileReference", () => {
  it("resolves worktree-relative and absolute paths inside the worktree, with or without lines", () => {
    expect(resolveFileReference("libs/shared/backend/src/index.ts", INDEX, BASE)).toEqual({ path: "libs/shared/backend/src/index.ts" });
    expect(resolveFileReference(`${BASE}/CLAUDE.md:3`, INDEX, BASE)).toEqual({ path: "CLAUDE.md", startLine: 3, endLine: 3 });
    expect(resolveFileReference("./CLAUDE.md:L4-L9", INDEX, BASE)).toEqual({ path: "CLAUDE.md", startLine: 4, endLine: 9 });
    expect(resolveFileReference("CLAUDE.md:7:12", INDEX, BASE)).toEqual({ path: "CLAUDE.md", startLine: 7, endLine: 7 });
  });

  it("resolves the end of a path or a bare file name when exactly one file fits", () => {
    expect(resolveFileReference("dto-utility.types.ts:65-68", INDEX, BASE)).toEqual({
      path: "libs/shared/backend/src/lib/utilities/dtos/dto-utility.types.ts",
      startLine: 65,
      endLine: 68,
    });
    expect(resolveFileReference("content/summary.service.ts:10", INDEX, BASE)?.path).toBe("apps/med/backend/src/app/api/content/summary.service.ts");
    expect(resolveFileReference("content/index.ts", INDEX, BASE)?.path).toBe("apps/med/backend/src/app/api/content/index.ts");
    expect(resolveFileReference("index.ts", INDEX, BASE)).toBeNull();
    expect(resolveFileReference("ontent/index.ts", INDEX, BASE)).toBeNull();
  });

  it("prefers the exact path over files whose path ends with it", () => {
    expect(resolveFileReference("CLAUDE.md", INDEX, BASE)?.path).toBe("CLAUDE.md");
  });

  it("ignores code that names no file of the worktree", () => {
    for (const text of ["Opt<ID>", "[OptionalProps]?: 'id'", "tsc", "Dockerfile", ":51", "chat.error", "/etc/hosts", "missing.ts:3", "apps/med/backend"]) {
      expect(resolveFileReference(text, INDEX, BASE)).toBeNull();
    }
  });
});
