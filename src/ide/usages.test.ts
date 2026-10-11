import { describe, expect, it } from "vitest";
import { containerOf, isImportLine, isSourceFile, kindLabel, parameterTypesOf, sliceRuns, sortUsages, stepSelection, usageCountLabel, usageOnLine } from "./usages";

describe("usageOnLine", () => {
  it("trims the indentation and shifts the match offsets", () => {
    const lineText = "    const container = queries.searchClassifications(signal);";
    const column = lineText.indexOf("searchClassifications") + 1;
    const usage = usageOnLine("a.ts", 26, column, column + "searchClassifications".length, lineText, "inject");
    expect(usage.text).toBe("const container = queries.searchClassifications(signal);");
    expect(usage.text.slice(usage.matchStart, usage.matchEnd)).toBe("searchClassifications");
    expect(usage).toMatchObject({ path: "a.ts", line: 26, column, container: "inject" });
  });

  it("keeps a match on an unindented line unchanged", () => {
    const usage = usageOnLine("a.ts", 1, 8, 15, "import { Thing } from './thing';", "");
    expect(usage.text.slice(usage.matchStart, usage.matchEnd)).toBe("{ Thing");
  });
});

describe("sortUsages", () => {
  it("orders by path, line and column", () => {
    const usages = [
      usageOnLine("b.ts", 3, 1, 2, "x", ""),
      usageOnLine("a.ts", 9, 5, 6, "x", ""),
      usageOnLine("a.ts", 9, 1, 2, "x", ""),
      usageOnLine("a.ts", 2, 1, 2, "x", ""),
    ];
    expect(sortUsages(usages).map((usage) => `${usage.path}:${usage.line}:${usage.column}`)).toEqual(["a.ts:2:1", "a.ts:9:1", "a.ts:9:5", "b.ts:3:1"]);
  });
});

describe("stepSelection", () => {
  it("stops at both ends and yields -1 for an empty list", () => {
    expect(stepSelection(0, -1, 3)).toBe(0);
    expect(stepSelection(1, 1, 3)).toBe(2);
    expect(stepSelection(2, 1, 3)).toBe(2);
    expect(stepSelection(0, 1, 0)).toBe(-1);
  });
});

describe("labels", () => {
  it("names kinds like WebStorm and counts usages", () => {
    expect(kindLabel("method")).toBe("Method");
    expect(kindLabel("local var")).toBe("Variable");
    expect(kindLabel("keyword")).toBe("Keyword");
    expect(kindLabel("")).toBe("Symbol");
    expect(usageCountLabel(0)).toBe("No usages");
    expect(usageCountLabel(1)).toBe("1 usage");
    expect(usageCountLabel(3)).toBe("3 usages");
  });

  it("recognises source files", () => {
    expect(isSourceFile("src/app.component.ts")).toBe(true);
    expect(isSourceFile("src/view.tsx")).toBe(true);
    expect(isSourceFile("README.md")).toBe(false);
    expect(isSourceFile("styles.css")).toBe(false);
  });
});

describe("isImportLine", () => {
  const lines = [
    "import { appConfig } from './app/app.config';",
    "import {",
    "  AppComponent,",
    "  OtherComponent,",
    "} from './app/app.component';",
    "export { appConfig } from './app/app.config';",
    "export * from './users';",
    "",
    "bootstrapApplication(AppComponent, appConfig);",
    "const x = {",
    "  appConfig,",
    "};",
    "export const importantConfig = appConfig;",
  ];

  it("recognises single-line imports and re-exports", () => {
    expect(isImportLine(lines, 1)).toBe(true);
    expect(isImportLine(lines, 6)).toBe(true);
    expect(isImportLine(lines, 7)).toBe(true);
  });

  it("recognises every line of a multi-line import", () => {
    expect(isImportLine(lines, 2)).toBe(true);
    expect(isImportLine(lines, 3)).toBe(true);
    expect(isImportLine(lines, 5)).toBe(true);
  });

  it("leaves code after the imports alone", () => {
    expect(isImportLine(lines, 9)).toBe(false);
    expect(isImportLine(lines, 11)).toBe(false);
    expect(isImportLine(lines, 13)).toBe(false);
  });
});

describe("parameterTypesOf", () => {
  it("lists the parameter types of a method's quick info", () => {
    expect(parameterTypesOf("(method) ClassificationQueries.searchClassifications(controls: any, options: any, parser: any): Observable<Result>")).toBe("(any, any, any)");
  });

  it("keeps nested generics, optional, rest and destructured parameters whole", () => {
    expect(parameterTypesOf("function inject<T>({ a, b }: Controls<T, Map<string, number>>, options?: Options, ...rest: any[]): void")).toBe("(Controls<T, Map<string, number>>, Options, any[])");
  });

  it("yields empty parentheses for a parameterless function and null without a parameter list", () => {
    expect(parameterTypesOf("(method) Foo.bar(): void")).toBe("()");
    expect(parameterTypesOf("const value: number")).toBeNull();
  });
});

describe("sliceRuns", () => {
  const style = { foreground: "ffffff", fontStyle: 0 };
  const runs = [
    { text: "const ", style },
    { text: "x", style: { ...style, foreground: "000000" } },
    { text: " = fn();", style },
  ];

  it("cuts across run boundaries and keeps the styles", () => {
    expect(sliceRuns(runs, 4, 9)).toEqual([
      { text: "t ", style },
      { text: "x", style: { ...style, foreground: "000000" } },
      { text: " =", style },
    ]);
  });

  it("yields nothing for an empty range", () => {
    expect(sliceRuns(runs, 3, 3)).toEqual([]);
  });
});

describe("containerOf", () => {
  it("skips variables and fields and names the enclosing function or class", () => {
    expect(containerOf([{ name: "inject", kind: "function" }, { name: "query", kind: "const" }])?.name).toBe("inject");
    expect(containerOf([{ name: "Browser", kind: "class" }, { name: "rootResult", kind: "property" }])?.name).toBe("Browser");
    expect(containerOf([{ name: "Browser", kind: "class" }, { name: "load", kind: "method" }])?.name).toBe("load");
  });

  it("yields undefined at top level", () => {
    expect(containerOf([])).toBeUndefined();
    expect(containerOf([{ name: "config", kind: "const" }])).toBeUndefined();
  });
});
