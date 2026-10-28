import { describe, expect, it } from "vitest";
import type { TextEdit } from "../../editor/line-diff.utils";
import { documentEdits, editsToText } from "./reformat.utils";

/** `lines` after `edits`, applied from the last to the first like Monaco applies simultaneous edits. */
function apply(lines: string[], edits: TextEdit[]): string {
  let text = lines.join("\n");
  const offset = (line: number, column: number) => lines.slice(0, line - 1).reduce((sum, current) => sum + current.length + 1, 0) + column - 1;
  for (const edit of [...edits].reverse()) {
    text = text.slice(0, offset(edit.startLine, edit.startColumn)) + edit.text + text.slice(offset(edit.endLine, edit.endColumn));
  }
  return text;
}

describe("editsToText", () => {
  it("replaces only the changed runs of lines", () => {
    const lines = ["import {a} from 'a'", "", "const x   = 1", "keep()", "const y=2", ""];
    const formatted = "import { a } from 'a';\n\nconst x = 1;\nkeep()\nconst y = 2;\n";
    const edits = editsToText(lines, "\n", formatted);
    expect(edits.map((edit) => edit.startLine)).toEqual([1, 3, 5]);
    expect(apply(lines, edits)).toBe(formatted);
  });

  it("removes deleted lines and adds a final line break", () => {
    const lines = ["import { b } from 'b';", "import { a } from 'a';", "a()"];
    const formatted = "import { a } from 'a';\na();\n";
    expect(apply(lines, editsToText(lines, "\n", formatted))).toBe(formatted);
  });

  it("adds or removes only the final line break", () => {
    expect(apply(["a;"], editsToText(["a;"], "\n", "a;\n"))).toBe("a;\n");
    expect(apply(["a;", "", ""], editsToText(["a;", "", ""], "\n", "a;\n"))).toBe("a;\n");
  });

  it("has nothing to do for formatted text", () => {
    expect(editsToText(["a;", ""], "\n", "a;\n")).toEqual([]);
  });
});

describe("documentEdits", () => {
  const edit = { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: "" };

  it("reads the edits of the document from changes or document changes", () => {
    expect(documentEdits({ changes: { "file:///a.ts": [edit], "file:///b.ts": [] } }, "file:///a.ts")).toEqual([edit]);
    expect(documentEdits({ documentChanges: [{ kind: "create" }, { textDocument: { uri: "file:///a.ts", version: 1 }, edits: [edit] }] }, "file:///a.ts")).toEqual([edit]);
    expect(documentEdits({ changes: { "file:///b.ts": [edit] } }, "file:///a.ts")).toEqual([]);
    expect(documentEdits(undefined, "file:///a.ts")).toEqual([]);
  });
});
