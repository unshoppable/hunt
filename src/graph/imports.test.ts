import { describe, expect, it } from "vitest";
import { importDescription, importLabel, isScriptFile, parseImports } from "./imports";

describe("parseImports", () => {
  it("reads default, namespace and named imports, re-exports, bare and dynamic imports", () => {
    const source = `
      import React, { useState, type Ref } from "react";
      import * as monaco from "monaco-editor";
      import type { FileDiff } from "../ipc/types";
      import { commands } from "../ipc/commands";
      import "./styles.css";
      export { buildTree as build } from "./changeTree";
      const elk = () => import("elkjs/lib/elk.bundled.js");
      const fs = require("node:fs");
    `;
    expect(parseImports(source)).toEqual([
      { specifier: "react", names: ["React", "useState", "Ref"], isTypeOnly: false },
      { specifier: "monaco-editor", names: ["monaco"], isTypeOnly: false },
      { specifier: "../ipc/types", names: ["FileDiff"], isTypeOnly: true },
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

describe("importLabel", () => {
  it("prefers the type-only marker, then the target's role, then the role the names imply; never a name", () => {
    expect(importLabel({ names: ["UserService"], isTypeOnly: true }, "user/user.service.ts")).toBe("types only");
    expect(importLabel({ names: ["UserService"], isTypeOnly: false }, "user/user.service.ts")).toBe("business logic");
    expect(importLabel({ names: ["PaginatedResult"], isTypeOnly: false }, "common/pagination/paginated.result.ts")).toBe("response shape");
    expect(importLabel({ names: [], isTypeOnly: false }, "src/graph/layout.ts")).toBe("side effects");
    expect(importLabel({ names: ["layoutDiagram", "labelWidth"], isTypeOnly: false }, "src/graph/layout.ts")).toBe("function calls");
    expect(importLabel({ names: ["GraphPanel"], isTypeOnly: false }, "src/graph/GraphPanel.tsx")).toBe("UI component");
  });
});

describe("importDescription", () => {
  it("lists every imported name and says where the text comes from", () => {
    expect(importDescription(["a", "b"], "src/m.ts")).toBe("Imports a, b from m.ts. Read from the import statement; update the diagram for the agent's explanation of this dependency.");
    expect(importDescription([], "src/m.ts")).toMatch(/^Imports m\.ts without naming anything from it\./);
  });
});

describe("isScriptFile", () => {
  it("accepts TypeScript and JavaScript files only", () => {
    expect(isScriptFile("src/a.tsx")).toBe(true);
    expect(isScriptFile("src-tauri/src/git.rs")).toBe(false);
    expect(isScriptFile("README")).toBe(false);
  });
});
