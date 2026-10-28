import { describe, expect, it } from "vitest";
import { packageScriptLines } from "./package-scripts.utils";

describe("packageScriptLines", () => {
  it("finds every key of the top-level scripts object with its line", () => {
    const text = ['{', '  "name": "app",', '  "scripts": {', '    "build": "tsc",', '    "test": "vitest run"', "  }", "}"].join("\n");
    expect(packageScriptLines(text)).toEqual([
      { script: "build", line: 4 },
      { script: "test", line: 5 },
    ]);
  });

  it("skips values, nested objects and arrays inside scripts", () => {
    const text = ['{ "scripts": {', '  "a": { "nested": "x" },', '  "b": ["c", "d"],', '  "e": "f"', "} }"].join("\n");
    expect(packageScriptLines(text)).toEqual([
      { script: "a", line: 2 },
      { script: "b", line: 3 },
      { script: "e", line: 4 },
    ]);
  });

  it("ignores a scripts key below the top level", () => {
    const text = ['{', '  "nx": { "scripts": { "inner": "x" } },', '  "scripts": { "outer": "y" }', "}"].join("\n");
    expect(packageScriptLines(text)).toEqual([{ script: "outer", line: 3 }]);
  });

  it("ignores a scripts string value and braces inside strings", () => {
    const text = ['{', '  "description": "scripts: { \\"fake\\": 1 }",', '  "x": "scripts",', '  "scripts": { "real": "echo }" }', "}"].join("\n");
    expect(packageScriptLines(text)).toEqual([{ script: "real", line: 4 }]);
  });

  it("decodes escapes in script names", () => {
    expect(packageScriptLines('{ "scripts": { "say\\"hi\\u0021": "echo" } }')).toEqual([{ script: 'say"hi!', line: 1 }]);
  });

  it("returns what it found in incomplete JSON", () => {
    const text = ['{', '  "scripts": {', '    "build": "tsc",', '    "te'].join("\n");
    expect(packageScriptLines(text)).toEqual([
      { script: "build", line: 3 },
      { script: "te", line: 4 },
    ]);
  });

  it("ends an unterminated string at its line, so later keys keep their lines", () => {
    const text = ['{', '  "scripts": {', '    "build": "ts', '    , "test": "vitest"', "  }", "}"].join("\n");
    expect(packageScriptLines(text)).toEqual([
      { script: "build", line: 3 },
      { script: "test", line: 4 },
    ]);
  });

  it("finds nothing without a top-level object or scripts", () => {
    expect(packageScriptLines("")).toEqual([]);
    expect(packageScriptLines('[{ "scripts": { "a": "b" } }]')).toEqual([]);
    expect(packageScriptLines('{ "name": "app" }')).toEqual([]);
    expect(packageScriptLines('{ "scripts": "build" }')).toEqual([]);
  });

  it("stops at the end of the top-level value", () => {
    expect(packageScriptLines('{ "scripts": { "a": "b" } } { "scripts": { "c": "d" } }')).toEqual([{ script: "a", line: 1 }]);
  });
});
