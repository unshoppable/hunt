import { describe, expect, it } from "vitest";
import { parseImportSpecifiers } from "./imports";

describe("parseImportSpecifiers", () => {
  it("finds import, export, side-effect, require and dynamic import specifiers", () => {
    const source = `
      import { Module } from "@nestjs/common";
      import type { User } from './user.entity';
      import * as fs from "node:fs";
      import "./polyfills";
      export { PageQuery } from "../common/page-query";
      export * from './index';
      const x = require("./legacy.js");
      const lazy = () => import('./lazy');
      const notAnImport = "from './nope'";
    `;
    expect(parseImportSpecifiers(source)).toEqual([
      "@nestjs/common",
      "./user.entity",
      "node:fs",
      "./polyfills",
      "../common/page-query",
      "./index",
      "./legacy.js",
      "./lazy",
    ]);
  });

  it("lists multi-line imports once", () => {
    const source = `import {\n  A,\n  B,\n} from "./ab";\nimport { A as C } from "./ab";`;
    expect(parseImportSpecifiers(source)).toEqual(["./ab"]);
  });
});
