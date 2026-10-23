import { describe, expect, it } from "vitest";
import {
  commentAndStringMatches,
  editsByUri,
  isCommentOrString,
  isIdentifier,
  isPackagePath,
  mergeOccurrences,
  mergeRenameEdits,
  nameProblem,
  occurrenceAt,
  occurrenceSummary,
  quickInfoKind,
  serverErrorMessage,
  wordOccurrence,
  wordOffsets,
  type LineToken,
} from "./rename";

describe("quickInfoKind", () => {
  it("reads the parenthesized kind of members and locals", () => {
    expect(quickInfoKind("(property) Foo.bar: string")).toBe("property");
    expect(quickInfoKind("(method) Queries.search(a: Foo): void")).toBe("method");
    expect(quickInfoKind("(enum member) Color.Red = 0")).toBe("enum member");
    expect(quickInfoKind("(local function) helper(): void")).toBe("local function");
  });

  it("reads the keyword of declarations", () => {
    expect(quickInfoKind("type EmbeddableAsResponseObject = {\n  id: string;\n}")).toBe("type");
    expect(quickInfoKind("interface Foo")).toBe("interface");
    expect(quickInfoKind("const isEmbeddedProperty: any")).toBe("const");
    expect(quickInfoKind("const enum Mode")).toBe("enum");
    expect(quickInfoKind("namespace Api")).toBe("module");
  });

  it("looks through an import alias", () => {
    expect(quickInfoKind("(alias) class UserService\nimport UserService")).toBe("class");
    expect(quickInfoKind("(alias) type Id = string\nimport Id")).toBe("type");
  });

  it("is empty for text without a kind", () => {
    expect(quickInfoKind("")).toBe("");
    expect(quickInfoKind("any")).toBe("");
  });
});

describe("isIdentifier", () => {
  it("accepts identifiers and private names", () => {
    expect(isIdentifier("userName")).toBe(true);
    expect(isIdentifier("$scope_2")).toBe(true);
    expect(isIdentifier("#count")).toBe(true);
    expect(isIdentifier("größe")).toBe(true);
  });

  it("rejects names that cannot be identifiers", () => {
    expect(isIdentifier("")).toBe(false);
    expect(isIdentifier("1abc")).toBe(false);
    expect(isIdentifier("user name")).toBe(false);
    expect(isIdentifier("a-b")).toBe(false);
  });
});

describe("nameProblem", () => {
  it("accepts identifiers", () => {
    expect(nameProblem("userName", "name", "const")).toBeNull();
    expect(nameProblem("#total", "#count", "property")).toBeNull();
  });

  it("rejects names that are no identifiers or change a private name", () => {
    expect(nameProblem("1x", "Widget", "type")).toBe("'1x' is not a valid identifier.");
    expect(nameProblem("count", "#count", "property")).toBe("'count' is not a valid identifier.");
    expect(nameProblem("#count", "count", "property")).toBe("'#count' is not a valid identifier.");
  });

  it("rejects reserved words except for members", () => {
    expect(nameProblem("class", "Widget", "type")).toBe("'class' is a reserved word.");
    expect(nameProblem("default", "fallback", "property")).toBeNull();
  });

  it("leaves names that were no identifiers alone", () => {
    expect(nameProblem("dark mode", "light-mode", "")).toBeNull();
  });
});

describe("isPackagePath", () => {
  it("finds node_modules anywhere in the path", () => {
    expect(isPackagePath("node_modules/pkg/index.d.ts")).toBe(true);
    expect(isPackagePath("apps/web/node_modules/pkg/index.d.ts")).toBe(true);
    expect(isPackagePath("src/node_modules_helper.ts")).toBe(false);
  });
});

describe("serverErrorMessage", () => {
  it("drops the JSON-RPC error code", () => {
    expect(serverErrorMessage("-32803: You cannot rename this element.")).toBe("You cannot rename this element.");
    expect(serverErrorMessage(new Error("tsgo not found"))).toBe("tsgo not found");
  });
});

describe("wordOffsets", () => {
  it("finds the word only where it stands alone", () => {
    expect(wordOffsets("user, users, $user, user_, user.name, (user)", "user")).toEqual([0, 27, 39]);
    expect(wordOffsets("", "user")).toEqual([]);
    expect(wordOffsets("user", "")).toEqual([]);
  });
});

describe("isCommentOrString", () => {
  const tokens: LineToken[] = [
    { offset: 0, type: "keyword.ts" },
    { offset: 5, type: "variable.ts" },
    { offset: 10, type: "string.ts" },
    { offset: 20, type: "comment.doc.ts" },
  ];

  it("checks the token covering the offset", () => {
    expect(isCommentOrString(tokens, 6)).toBe(false);
    expect(isCommentOrString(tokens, 10)).toBe(true);
    expect(isCommentOrString(tokens, 25)).toBe(true);
    expect(isCommentOrString([], 0)).toBe(false);
  });
});

describe("commentAndStringMatches", () => {
  it("keeps matches in comments and strings, not in code or import paths", () => {
    const lines = ["import { user } from './user';", "// the user", "const user = 'user';"];
    const tokens: LineToken[][] = [
      [
        { offset: 0, type: "keyword.ts" },
        { offset: 21, type: "string.ts" },
      ],
      [{ offset: 0, type: "comment.ts" }],
      [
        { offset: 0, type: "keyword.ts" },
        { offset: 6, type: "variable.ts" },
        { offset: 13, type: "string.ts" },
      ],
    ];
    expect(commentAndStringMatches(lines, tokens, "user")).toEqual([
      { line: 1, offset: 7 },
      { line: 2, offset: 14 },
    ]);
  });
});

describe("editsByUri", () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };

  it("reads `changes`", () => {
    const edits = editsByUri({ changes: { "file:///a.ts": [{ range, newText: "b" }] } });
    expect([...edits.keys()]).toEqual(["file:///a.ts"]);
  });

  it("reads `documentChanges` without file operations", () => {
    const edits = editsByUri({
      documentChanges: [
        { textDocument: { uri: "file:///a.ts", version: 1 }, edits: [{ range, newText: "b" }] },
        { kind: "rename" },
        { textDocument: { uri: "file:///a.ts", version: 1 }, edits: [{ range, newText: "c" }] },
      ],
    });
    expect(edits.get("file:///a.ts")?.map((edit) => edit.newText)).toEqual(["b", "c"]);
    expect(editsByUri(null).size).toBe(0);
  });
});

/** The occurrence replacing the 1-based columns `column..endColumn` of `line`. */
function onLine(group: "code" | "comment" | "text", path: string, line: number, column: number, endColumn: number, lineText: string) {
  return occurrenceAt(group, path, { line, column, endLine: line, endColumn }, "name", lineText);
}

describe("mergeRenameEdits", () => {
  const edit = (line: number, character: number, length: number, newText: string) => ({ range: { start: { line, character }, end: { line, character: character + length } }, newText });

  it("adds the template edits and skips those at places TypeScript renames already", () => {
    const typescript = new Map([["file:///work%20tree/app.ts", [edit(4, 2, 7, "isDone")]]]);
    const angular = new Map([
      ["file:///work tree/app.ts", [edit(4, 2, 7, "isDone"), edit(9, 20, 7, "isDone")]],
      ["file:///work%20tree/app.html", [edit(0, 5, 7, "isDone")]],
    ]);
    expect(mergeRenameEdits(typescript, angular)).toEqual(
      new Map([
        ["file:///work%20tree/app.ts", [edit(4, 2, 7, "isDone"), edit(9, 20, 7, "isDone")]],
        ["file:///work%20tree/app.html", [edit(0, 5, 7, "isDone")]],
      ]),
    );
  });
});

describe("occurrenceAt", () => {
  it("trims the indentation and marks the replaced range", () => {
    const occurrence = occurrenceAt("code", "a.ts", { line: 4, column: 9, endLine: 4, endColumn: 13 }, "name", "    if (user) {");
    expect(occurrence).toMatchObject({ key: "a.ts:4:9", text: "if (user) {", newText: "name" });
    expect(occurrence.text.slice(occurrence.matchStart, occurrence.matchEnd)).toBe("user");
  });

  it("marks a range spanning lines up to the end of its first line", () => {
    const occurrence = occurrenceAt("code", "a.ts", { line: 1, column: 7, endLine: 2, endColumn: 3 }, "name", "const user");
    expect(occurrence.text.slice(occurrence.matchStart, occurrence.matchEnd)).toBe("user");
  });
});

describe("wordOccurrence", () => {
  it("covers the word at a match", () => {
    const occurrence = wordOccurrence("text", "README.md", ["# Users", "The user list"], { line: 1, offset: 4 }, "user", "member");
    expect(occurrence).toMatchObject({ line: 2, column: 5, endLine: 2, endColumn: 9, newText: "member", text: "The user list" });
  });
});

describe("mergeOccurrences", () => {
  it("drops text matches the language server renames and orders by group, path and position", () => {
    const merged = mergeOccurrences([
      onLine("text", "README.md", 3, 1, 5, "user here"),
      onLine("comment", "b.ts", 2, 5, 9, "// user"),
      onLine("comment", "a.ts", 1, 7, 11, "const user = 1;"),
      onLine("code", "a.ts", 1, 7, 11, "const user = 1;"),
    ]);
    expect(merged.map((occurrence) => occurrence.key)).toEqual(["a.ts:1:7", "b.ts:2:5", "README.md:3:1"]);
    expect(merged.map((occurrence) => occurrence.group)).toEqual(["code", "comment", "text"]);
  });
});

describe("occurrenceSummary", () => {
  it("counts usages and files", () => {
    const one = onLine("code", "a.ts", 1, 1, 5, "user");
    const two = onLine("code", "b.ts", 1, 1, 5, "user");
    expect(occurrenceSummary([])).toBe("No usages");
    expect(occurrenceSummary([one])).toBe("1 usage in 1 file");
    expect(occurrenceSummary([one, two])).toBe("2 usages in 2 files");
  });
});
