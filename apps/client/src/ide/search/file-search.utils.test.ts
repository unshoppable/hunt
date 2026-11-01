import { describe, expect, it } from "vitest";
import { parseQuery, searchFiles } from "./file-search.utils";

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

  it("ranks a name containing a long query above a name matching it only as a subsequence", () => {
    const paths = [
      "apps/backend/src/app/api/specialist-department/entities/__tests/specialist-department-case-base.domain.spec-sqlite.ts",
      "apps/backend/src/app/api/specialist-department/entities/specialist-department-case-base.domain.ts",
    ];
    const names = searchFiles(paths, "specialist-department-case-base.domain.ts").map((match) => match.name);
    expect(names).toEqual(["specialist-department-case-base.domain.ts", "specialist-department-case-base.domain.spec-sqlite.ts"]);
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

  it("ranks the best alignment, not the first occurrence of each letter, and marks its letters", () => {
    const paths = ["src/contractorial.ts", "src/ui/ContentTreeRowList.tsx"];
    const [best, second] = searchFiles(paths, "ctrl");
    expect(best?.name).toBe("ContentTreeRowList.tsx");
    expect(best!.positions.map((position) => best!.path[position]).join("")).toBe("CTrL");
    expect(best!.score).toBeGreaterThan(second!.score);
  });

  it("prefers word starts over letters inside words", () => {
    const [best, second] = searchFiles(["src/fixtureFinder.ts", "src/ide/search/FindInFilesDialog.tsx"], "fif");
    expect(best?.name).toBe("FindInFilesDialog.tsx");
    expect(best!.score).toBeGreaterThan(second!.score);
  });

  it("ignores whitespace in the query", () => {
    const paths = ["src/ide/search/FindInFilesDialog.tsx", "src/ide/search/file-search.utils.ts"];
    const [match] = searchFiles(paths, "find files");
    expect(match?.name).toBe("FindInFilesDialog.tsx");
    expect(match!.positions.map((position) => match!.path[position]).join("")).toBe("FindFiles");
    expect(searchFiles(paths, parseQuery("find files:12").text)[0]?.name).toBe("FindInFilesDialog.tsx");
  });

  it("boosts an exact name, a name without its extension and the exact case of a query with capitals", () => {
    expect(searchFiles(["a/ward-edit.ts", "b/ward.ts"], "ward.ts")[0]?.path).toBe("b/ward.ts");
    expect(searchFiles(["a/user-list.ts", "b/user.ts"], "user")[0]?.path).toBe("b/user.ts");
    expect(searchFiles(["a/readme.md", "b/README.md"], "README")[0]?.path).toBe("b/README.md");
  });

  it("matches the part after the last slash in the name and the rest in the directories", () => {
    const [match] = searchFiles(PATHS, "ide/pt");
    expect(match?.path).toBe("src/ide/ProjectTree.tsx");
    expect(match!.positions.map((position) => match!.path[position]).join("")).toBe("idePT");
    expect(searchFiles(PATHS, "ide/")[0]?.path).toBe("src/ide/ProjectTree.tsx");
    expect(searchFiles(PATHS, "readme/md")).toEqual([]);
  });

  it("caps the result count", () => {
    expect(searchFiles(PATHS, "s", 2)).toHaveLength(2);
  });
});
