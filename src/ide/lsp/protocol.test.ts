import { describe, expect, it } from "vitest";
import { asLocationLinks, elementKindOf, hoverSignature, rangeContains, resolvedFields, symbolsAt, toContentChanges, toLspPosition, toMonacoCompletion, toMonacoCompletionKind, toMonacoRange, toMonacoSignatureHelp, type DocumentSymbol } from "./protocol";

const range = (startLine: number, startCharacter: number, endLine: number, endCharacter: number) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
});

describe("positions and ranges", () => {
  it("converts between Monaco's 1-based and LSP's 0-based coordinates", () => {
    expect(toLspPosition({ lineNumber: 3, column: 7 })).toEqual({ line: 2, character: 6 });
    expect(toMonacoRange(range(0, 0, 1, 4))).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 5 });
  });

  it("treats both ends of a range as inside", () => {
    expect(rangeContains(range(1, 2, 1, 6), { line: 1, character: 2 })).toBe(true);
    expect(rangeContains(range(1, 2, 1, 6), { line: 1, character: 6 })).toBe(true);
    expect(rangeContains(range(1, 2, 1, 6), { line: 1, character: 7 })).toBe(false);
    expect(rangeContains(range(1, 2, 3, 0), { line: 2, character: 40 })).toBe(true);
  });

  it("maps Monaco edits to LSP content changes in event order", () => {
    const event = {
      changes: [
        { range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 3 }, text: "" },
        { range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 }, text: "x" },
      ],
    } as unknown as import("monaco-editor").editor.IModelContentChangedEvent;
    expect(toContentChanges(event)).toEqual([
      { range: range(4, 0, 4, 2), text: "" },
      { range: range(0, 1, 0, 1), text: "x" },
    ]);
  });
});

describe("symbolsAt", () => {
  const symbols: DocumentSymbol[] = [
    { name: "Controller", kind: 13, range: range(0, 9, 0, 19), selectionRange: range(0, 9, 0, 19), children: [] },
    {
      name: "UserController",
      kind: 5,
      range: range(2, 0, 20, 1),
      selectionRange: range(2, 13, 2, 27),
      children: [{ name: "findOne", kind: 6, range: range(5, 2, 9, 3), selectionRange: range(5, 8, 5, 15) }],
    },
  ];

  it("returns the enclosing declarations outermost first", () => {
    expect(symbolsAt(symbols, { line: 6, character: 4 }).map((symbol) => symbol.name)).toEqual(["UserController", "findOne"]);
    expect(symbolsAt(symbols, { line: 3, character: 0 }).map((symbol) => symbol.name)).toEqual(["UserController"]);
  });

  it("is empty outside every symbol and without symbols", () => {
    expect(symbolsAt(symbols, { line: 1, character: 0 })).toEqual([]);
    expect(symbolsAt(undefined, { line: 1, character: 0 })).toEqual([]);
  });
});

describe("hoverSignature", () => {
  it("takes the code of the first fenced block", () => {
    const hover = { contents: { kind: "markdown" as const, value: "```tsx\n(method) UserController.findOne(id: string): Promise<User>\n```\nFinds one user." } };
    expect(hoverSignature(hover)).toBe("(method) UserController.findOne(id: string): Promise<User>");
  });

  it("falls back to the plain text", () => {
    expect(hoverSignature({ contents: "const answer: number" })).toBe("const answer: number");
    expect(hoverSignature({ contents: [{ language: "typescript", value: "let x: string" }] })).toBe("let x: string");
  });
});

describe("asLocationLinks", () => {
  it("accepts links, locations, single items and nothing", () => {
    const location = { uri: "file:///a.ts", range: range(1, 0, 1, 3) };
    expect(asLocationLinks(null)).toEqual([]);
    expect(asLocationLinks(location)).toEqual([{ targetUri: "file:///a.ts", targetRange: location.range, targetSelectionRange: location.range }]);
    const link = { targetUri: "file:///b.ts", targetRange: range(0, 0, 2, 0), targetSelectionRange: range(0, 5, 0, 8) };
    expect(asLocationLinks([link])).toEqual([link]);
  });
});

describe("elementKindOf", () => {
  it("names the kinds the popup and icons know", () => {
    expect(elementKindOf(5)).toBe("class");
    expect(elementKindOf(6)).toBe("method");
    expect(elementKindOf(9)).toBe("constructor");
    expect(elementKindOf(22)).toBe("enum member");
    expect(elementKindOf(99)).toBe("");
  });
});

describe("completion", () => {
  const wordRange = { startLineNumber: 6, startColumn: 5, endLineNumber: 6, endColumn: 8 };

  it("maps the server's kinds onto Monaco's and falls back to text", () => {
    expect(toMonacoCompletionKind(2)).toBe(0); // method
    expect(toMonacoCompletionKind(5)).toBe(3); // field
    expect(toMonacoCompletionKind(7)).toBe(5); // class
    expect(toMonacoCompletionKind(15)).toBe(28); // snippet
    expect(toMonacoCompletionKind(25)).toBe(24); // type parameter
    expect(toMonacoCompletionKind(undefined)).toBe(18);
    expect(toMonacoCompletionKind(99)).toBe(18);
  });

  it("uses the item's insert/replace edit, filter text and the list's commit characters", () => {
    const item = { label: "offset?", kind: 5, sortText: "12", filterText: "offset", textEdit: { newText: "offset", insert: range(5, 4, 5, 7), replace: range(5, 4, 5, 9) }, data: { name: "offset" } };
    const suggestion = toMonacoCompletion(item, { commitCharacters: [".", ",", ";"] }, wordRange);
    expect(suggestion.label).toBe("offset?");
    expect(suggestion.filterText).toBe("offset");
    expect(suggestion.insertText).toBe("offset");
    expect(suggestion.range).toEqual({ insert: toMonacoRange(range(5, 4, 5, 7)), replace: toMonacoRange(range(5, 4, 5, 9)) });
    expect(suggestion.commitCharacters).toEqual([".", ",", ";"]);
    expect(suggestion.insertTextRules).toBeUndefined();
    expect(suggestion.lsp).toEqual(item);
  });

  it("falls back to the list's edit range, then to the word before the cursor", () => {
    const withDefault = toMonacoCompletion({ label: "length" }, { editRange: range(7, 8, 7, 11), data: { shared: true } }, wordRange);
    expect(withDefault.range).toEqual(toMonacoRange(range(7, 8, 7, 11)));
    expect(withDefault.lsp.data).toEqual({ shared: true });
    const bare = toMonacoCompletion({ label: "length" }, undefined, wordRange);
    expect(bare.range).toEqual(wordRange);
    expect(bare.insertText).toBe("length");
  });

  it("shows the auto-import source, marks snippets and deprecated items", () => {
    const suggestion = toMonacoCompletion({ label: "Helper", kind: 7, labelDetails: { description: "./options" }, insertText: "Helper($1)", tags: [1] }, { insertTextFormat: 2 }, wordRange);
    expect(suggestion.label).toEqual({ label: "Helper", detail: undefined, description: "./options" });
    expect(suggestion.insertTextRules).toBe(4);
    expect(suggestion.tags).toEqual([1]);
  });

  it("turns a resolved item's detail, documentation and import edits into Monaco's fields", () => {
    const fields = resolvedFields({ label: "Helper", detail: "Update import from \"./options\"", documentation: { kind: "markdown", value: "Does things." }, additionalTextEdits: [{ range: range(0, 21, 0, 21), newText: ",Helper" }] });
    expect(fields.detail).toBe("Update import from \"./options\"");
    expect(fields.documentation).toEqual({ value: "Does things." });
    expect(fields.additionalTextEdits).toEqual([{ range: toMonacoRange(range(0, 21, 0, 21)), text: ",Helper" }]);
    expect(resolvedFields({ label: "x", documentation: { kind: "plaintext", value: "raw" } }).documentation).toEqual({ value: "```\nraw\n```" });
  });
});

describe("signature help", () => {
  it("keeps labels and offsets and defaults the active indexes", () => {
    const help = toMonacoSignatureHelp({ signatures: [{ label: "f(a: string, b: number): void", parameters: [{ label: "a: string" }, { label: [12, 21], documentation: "second" }] }] });
    expect(help.activeSignature).toBe(0);
    expect(help.activeParameter).toBe(0);
    expect(help.signatures[0].parameters[1]).toEqual({ label: [12, 21], documentation: { value: "second" } });
    expect(toMonacoSignatureHelp({ signatures: [], activeSignature: 1, activeParameter: 2 })).toEqual({ signatures: [], activeSignature: 1, activeParameter: 2 });
  });
});
