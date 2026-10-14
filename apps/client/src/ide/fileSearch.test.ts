import { describe, expect, it } from "vitest";
import { parseQuery, searchFiles } from "./fileSearch";

const PATHS = [
  "apps/admin-ui/src/app/pages/location-detail/components/ward-dialog/ward-edit-dialog.component.html",
  "apps/admin-ui/src/app/pages/location-detail/components/ward-dialog/ward-edit-dialog.component.ts",
  "apps/backend/src/app/api/organization/ward/entities/ward.entity.ts",
  "apps/backend/src/app/shared/utilities/ward-belongs-to-own-location.utils.ts",
  "apps/backend/src/app/api/reward/reward.service.ts",
  "src/ide/ProjectTree.tsx",
  "README.md",
];

describe("parseQuery", () => {
  it("splits a trailing line number off the text", () => {
    expect(parseQuery("ward.entity:42")).toEqual({ text: "ward.entity", line: 42 });
    expect(parseQuery("  ward  ")).toEqual({ text: "ward", line: null });
    expect(parseQuery("ward:0")).toEqual({ text: "ward", line: null });
  });
});

describe("searchFiles", () => {
  it("matches nothing for an empty query", () => {
    expect(searchFiles(PATHS, "   ")).toEqual([]);
  });

  it("ranks names starting with the query above names merely containing it", () => {
    const names = searchFiles(PATHS, "ward").map((match) => match.name);
    expect(names[0]).toBe("ward.entity.ts");
    expect(names.slice(0, 4).sort()).toEqual([
      "ward-belongs-to-own-location.utils.ts",
      "ward-edit-dialog.component.html",
      "ward-edit-dialog.component.ts",
      "ward.entity.ts",
    ]);
    expect(names).toContain("reward.service.ts");
    expect(names.indexOf("reward.service.ts")).toBeGreaterThan(3);
  });

  it("matches camel humps and separators as a subsequence", () => {
    expect(searchFiles(PATHS, "wedc")[0]?.name).toBe("ward-edit-dialog.component.ts");
    expect(searchFiles(PATHS, "PT")[0]?.name).toBe("ProjectTree.tsx");
  });

  it("matches whole paths when the query contains a slash", () => {
    const paths = searchFiles(PATHS, "ward-dialog/ward").map((match) => match.path);
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.includes("ward-dialog/ward"))).toBe(true);
  });

  it("falls back to the path when the name does not match", () => {
    const [match] = searchFiles(PATHS, "organization");
    expect(match?.path).toBe("apps/backend/src/app/api/organization/ward/entities/ward.entity.ts");
  });

  it("reports the matched character positions within the path", () => {
    const [match] = searchFiles(PATHS, "readme");
    expect(match?.positions).toEqual([0, 1, 2, 3, 4, 5]);
    const [byName] = searchFiles(PATHS, "ward.entity");
    expect(byName?.positions[0]).toBe(byName!.path.lastIndexOf("/") + 1);
  });

  it("caps the result count", () => {
    expect(searchFiles(PATHS, "s", 2)).toHaveLength(2);
  });
});
