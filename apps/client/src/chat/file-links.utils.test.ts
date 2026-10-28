import { describe, expect, it } from "vitest";
import { createFileIndex, resolveFileLink, resolveFileReference } from "./file-links.utils";

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

describe("resolveFileLink", () => {
  it("resolves link targets written like inline code, as file URLs and with line fragments", () => {
    expect(resolveFileLink("apps/med/CLAUDE.md:12", INDEX, BASE)).toEqual({ path: "apps/med/CLAUDE.md", startLine: 12, endLine: 12 });
    expect(resolveFileLink("summary.service.ts:3-9", INDEX, BASE)?.path).toBe("apps/med/backend/src/app/api/content/summary.service.ts");
    expect(resolveFileLink(`file://${BASE}/CLAUDE.md`, INDEX, BASE)).toEqual({ path: "CLAUDE.md" });
    expect(resolveFileLink("CLAUDE.md#L4", INDEX, BASE)).toEqual({ path: "CLAUDE.md", startLine: 4, endLine: 4 });
    expect(resolveFileLink("apps/med/CLAUDE.md#L4-L9", INDEX, BASE)).toEqual({ path: "apps/med/CLAUDE.md", startLine: 4, endLine: 9 });
  });

  it("decodes percent-encoded targets", () => {
    expect(resolveFileLink("apps%2Fmed%2FCLAUDE.md:2", INDEX, BASE)).toEqual({ path: "apps/med/CLAUDE.md", startLine: 2, endLine: 2 });
  });

  it("ignores web URLs, other schemes, malformed encodings and paths outside the worktree", () => {
    for (const href of ["https://github.com/a/b/blob/main/CLAUDE.md", "mailto:me@example.com", "javascript:1", "CLAUDE.md%", "/etc/hosts#L1", "#L3", "missing.ts:3"]) {
      expect(resolveFileLink(href, INDEX, BASE)).toBeNull();
    }
  });
});
