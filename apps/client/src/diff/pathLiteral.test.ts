import { describe, expect, it } from "vitest";
import { pathLiteralAt } from "./pathLiteral";

describe("pathLiteralAt", () => {
  const line = "  templateUrl: './job-listing-detail.page.html',";

  it("spans the whole text of a relative path literal, quotes excluded", () => {
    expect(pathLiteralAt(line, 20)).toEqual({ path: "./job-listing-detail.page.html", startColumn: 17, endColumn: 47 });
  });

  it("counts the first column and the one behind the last character", () => {
    expect(pathLiteralAt(line, 17)?.path).toBe("./job-listing-detail.page.html");
    expect(pathLiteralAt(line, 47)?.path).toBe("./job-listing-detail.page.html");
    expect(pathLiteralAt(line, 15)).toBeNull();
    expect(pathLiteralAt(line, 48)).toBeNull();
  });

  it("finds parent paths in any quote style and picks the literal under the column", () => {
    const imports = `import { a } from "../a/a.service"; const b = \`../b.html\`;`;
    expect(pathLiteralAt(imports, 22)?.path).toBe("../a/a.service");
    expect(pathLiteralAt(imports, 50)?.path).toBe("../b.html");
  });

  it("ignores package names, plain text and interpolated paths", () => {
    expect(pathLiteralAt(`import { Component } from '@angular/core';`, 30)).toBeNull();
    expect(pathLiteralAt(`const label = 'job listing';`, 18)).toBeNull();
    expect(pathLiteralAt("const url = `./${name}.html`;", 16)).toBeNull();
  });
});
