import { DiffFile } from "@git-diff-view/react";
import { describe, expect, it } from "vitest";
import { diffFenceOldText, diffFencePatch } from "./diff-fence.utils";

const PATH = "src/api.service.ts";
const FENCE = [
  " export class ApiService {",
  "-  constructor(@Inject(MAIN_API_URL) protected apiUrl: string) {}",
  "+  protected readonly apiUrl: string;",
  "+",
  "+  constructor(backendOrigin: string, api: BackendApi) {",
  "+    this.apiUrl = buildApiUrl(backendOrigin, api);",
  "+  }",
  "",
  "   createUrl(endpoint: string): string {",
].join("\n");

/** The old and new line number and text of each row git-diff-view renders for `patch`. */
function renderedRows(patch: string | null): [number | undefined, number | undefined, string][] {
  if (!patch) throw new Error("the fence yields no patch");
  const file = new DiffFile(PATH, "", PATH, "", [patch], "typescript", "typescript");
  file.initRaw();
  file.buildUnifiedDiffLines();
  const rows: [number | undefined, number | undefined, string][] = [];
  for (let index = 0; index < file.unifiedLineLength; index++) {
    const line = file.getUnifiedLine(index);
    rows.push([line.oldLineNumber, line.newLineNumber, line.value?.replace(/\n$/, "") ?? ""]);
  }
  return rows;
}

describe("diffFencePatch", () => {
  it("numbers prefixed lines from the line the fence's file place names", () => {
    expect(renderedRows(diffFencePatch(FENCE, PATH, 54))).toStrictEqual([
      [54, 54, "export class ApiService {"],
      [55, undefined, "  constructor(@Inject(MAIN_API_URL) protected apiUrl: string) {}"],
      [undefined, 55, "  protected readonly apiUrl: string;"],
      [undefined, 56, ""],
      [undefined, 57, "  constructor(backendOrigin: string, api: BackendApi) {"],
      [undefined, 58, "    this.apiUrl = buildApiUrl(backendOrigin, api);"],
      [undefined, 59, "  }"],
      [56, 60, ""],
      [57, 61, "  createUrl(endpoint: string): string {"],
    ]);
  });

  it("keeps the numbers of hunk headers the agent wrote and drops a file header", () => {
    const fence = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -3,2 +3,2 @@", " a", "-b", "+B", "@@ -9,1 +9,1 @@", "-c", "+C"].join("\n");
    expect(renderedRows(diffFencePatch(fence, PATH, 1))).toStrictEqual([
      [3, 3, "a"],
      [4, undefined, "b"],
      [undefined, 4, "B"],
      [9, undefined, "c"],
      [undefined, 9, "C"],
    ]);
  });

  it("starts an insertion's empty old side at the line before it", () => {
    expect(diffFencePatch("+a", PATH, 7)).toBe(`--- a/${PATH}\n+++ b/${PATH}\n@@ -6,0 +7,1 @@\n+a\n`);
  });

  it("is null while the fence changes no line, as at the start of a streamed reply", () => {
    expect(diffFencePatch(" export class ApiService {\n", PATH, 54)).toBeNull();
  });
});

describe("diffFenceOldText", () => {
  it("is the context and removed lines without their prefix", () => {
    expect(diffFenceOldText(FENCE)).toBe(
      ["export class ApiService {", "  constructor(@Inject(MAIN_API_URL) protected apiUrl: string) {}", "", "  createUrl(endpoint: string): string {"].join("\n"),
    );
  });

  it("keeps a removed line that looks like a file header when context precedes it", () => {
    expect(diffFenceOldText([" select 1;", "--- old comment", "+++ new comment"].join("\n"))).toBe("select 1;\n-- old comment");
  });
});
