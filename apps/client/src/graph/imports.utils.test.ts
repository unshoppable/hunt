import { describe, expect, it } from "vitest";
import { isScriptFile, parseImports } from "./imports.utils";

describe("parseImports", () => {
  it("reads default, namespace and named imports, re-exports, bare and dynamic imports", () => {
    const source = `
      import React, { useState, type Ref } from "react";
      import * as monaco from "monaco-editor";
      import type { FileDiff } from "../diff/diff.types";
      import { commands } from "../ipc/commands";
      import "./styles.css";
      export { buildTree as build } from "./changeTree";
      const elk = () => import("elkjs/lib/elk.bundled.js");
      const fs = require("node:fs");
    `;
    expect(parseImports(source)).toEqual([
      { specifier: "react", names: ["React", "useState", "Ref"], isTypeOnly: false },
      { specifier: "monaco-editor", names: ["monaco"], isTypeOnly: false },
      { specifier: "../diff/diff.types", names: ["FileDiff"], isTypeOnly: true },
      { specifier: "../ipc/commands", names: ["commands"], isTypeOnly: false },
      { specifier: "./changeTree", names: ["buildTree"], isTypeOnly: false },
      { specifier: "./styles.css", names: [], isTypeOnly: false },
      { specifier: "elkjs/lib/elk.bundled.js", names: [], isTypeOnly: false },
      { specifier: "node:fs", names: [], isTypeOnly: false },
    ]);
  });

  it("merges several imports of the same module; a value import makes the merge not type-only", () => {
    expect(parseImports(`import { a } from "./m";\nimport type { B } from "./m";`)).toEqual([{ specifier: "./m", names: ["a", "B"], isTypeOnly: false }]);
    expect(parseImports(`import { type A } from "./m";\nimport type { B } from "./m";`)).toEqual([{ specifier: "./m", names: ["A", "B"], isTypeOnly: true }]);
  });
});

describe("isScriptFile", () => {
  it("accepts TypeScript and JavaScript files only", () => {
    expect(isScriptFile("src/a.tsx")).toBe(true);
    expect(isScriptFile("src-tauri/src/git.rs")).toBe(false);
    expect(isScriptFile("README")).toBe(false);
  });
});
