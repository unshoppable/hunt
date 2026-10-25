import { describe, expect, it } from "vitest";
import type { TextMatch } from "../ipc/types";
import { searchFiles } from "./fileSearch";
import { declarationQuery, declarationsOf, isSymbolQuery, mergeResults, rankSymbols, resultGroup, workspaceSymbolsIn, type SymbolCandidate } from "./symbolSearch";

function textMatch(path: string, line: number, preview: string, start = 0): TextMatch {
  return { path, line, column: start + 1, endColumn: preview.length + 1, preview, ranges: [{ start, end: preview.length }] };
}

function candidate(name: string, kind: string, path = "src/a.ts", line = 1): SymbolCandidate {
  return { name, kind, containerName: "", path, line, column: 1 };
}

describe("isSymbolQuery", () => {
  it("accepts identifiers only", () => {
    expect(isSymbolQuery("PdfDocumentVector")).toBe(true);
    expect(isSymbolQuery("$store")).toBe(true);
    expect(isSymbolQuery("ward.entity")).toBe(false);
    expect(isSymbolQuery("api/ward")).toBe(false);
    expect(isSymbolQuery("2fa")).toBe(false);
  });
});

describe("declarationQuery", () => {
  it("matches unindented declarations whose name contains the text, ignoring case", () => {
    const query = declarationQuery("documentvector");
    const pattern = new RegExp(query.text, "i");
    expect(query).toMatchObject({ isRegex: true, matchCase: false });
    expect(pattern.test("export class PdfDocumentVector {")).toBe(true);
    expect(pattern.test("export abstract class DocumentVectorBase {")).toBe(true);
    expect(pattern.test("type DocumentVectors = string[];")).toBe(true);
    expect(pattern.test("  const documentVector = load();")).toBe(false);
    expect(pattern.test("new PdfDocumentVector();")).toBe(false);
  });

  it("escapes a dollar sign in the text", () => {
    expect(new RegExp(declarationQuery("$store").text).test("const $store = create();")).toBe(true);
  });
});

describe("declarationsOf", () => {
  it("reads kind, name and the name's column from the matched lines", () => {
    const found = declarationsOf([
      textMatch("src/pdf-vector.embeddable.ts", 40, "export class PdfDocumentVector {"),
      textMatch("src/types.ts", 3, "export default async function* readVectors() {"),
      textMatch("src/ns.ts", 7, "declare namespace Vectors {"),
      textMatch("src/long.ts", 9, "…lead export const VectorTable = 1;", 6),
    ]);
    expect(found).toEqual([
      { name: "PdfDocumentVector", kind: "class", containerName: "", path: "src/pdf-vector.embeddable.ts", line: 40, column: 14 },
      { name: "readVectors", kind: "function", containerName: "", path: "src/types.ts", line: 3, column: 32 },
      { name: "Vectors", kind: "module", containerName: "", path: "src/ns.ts", line: 7, column: 19 },
      { name: "VectorTable", kind: "const", containerName: "", path: "src/long.ts", line: 9, column: 20 },
    ]);
  });
});

describe("workspaceSymbolsIn", () => {
  it("keeps the symbols of listed worktree files with 1-based positions", () => {
    const location = (uri: string) => ({ uri, range: { start: { line: 39, character: 13 }, end: { line: 39, character: 30 } } });
    const symbols = [
      { name: "PdfDocumentVector", kind: 5, location: location("file:///repo/apps/pdf%20vector.ts") },
      { name: "toJSON", kind: 6, containerName: "PdfDocumentVector", location: location("file:///repo/apps/pdf%20vector.ts") },
      { name: "Vector", kind: 11, location: location("file:///repo/node_modules/lib/index.d.ts") },
      { name: "Other", kind: 5, location: location("file:///elsewhere/a.ts") },
      { name: "Unresolved", kind: 5, location: { uri: "file:///repo/apps/pdf%20vector.ts" } },
    ];
    expect(workspaceSymbolsIn(symbols, "/repo", new Set(["apps/pdf vector.ts"]))).toEqual([
      { name: "PdfDocumentVector", kind: "class", containerName: "", path: "apps/pdf vector.ts", line: 40, column: 14 },
      { name: "toJSON", kind: "method", containerName: "PdfDocumentVector", path: "apps/pdf vector.ts", line: 40, column: 14 },
    ]);
  });
});

describe("rankSymbols", () => {
  it("ranks exact and prefix names first, classes before other kinds on a tie, and drops duplicates and misses", () => {
    const ranked = rankSymbols(
      [
        candidate("CreatePdfDocumentVectorDto", "class", "src/dto.ts"),
        candidate("pdfDocumentVector", "const", "src/const.ts"),
        candidate("PdfDocumentVector", "class", "src/entity.ts"),
        candidate("PdfDocumentVector", "class", "src/entity.ts"),
        candidate("Unrelated", "class"),
      ],
      "PdfDocumentVector",
    );
    expect(ranked.map((match) => `${match.name}@${match.path}`)).toEqual(["PdfDocumentVector@src/entity.ts", "pdfDocumentVector@src/const.ts", "CreatePdfDocumentVectorDto@src/dto.ts"]);
    expect(ranked[0]?.positions).toHaveLength("PdfDocumentVector".length);
  });

  it("matches camel humps and caps the result count", () => {
    expect(rankSymbols([candidate("PdfDocumentVector", "class")], "pdfdocvec")).toHaveLength(1);
    expect(rankSymbols([candidate("Alpha", "class", "a.ts"), candidate("Alps", "class", "b.ts")], "al", 1)).toHaveLength(1);
    expect(rankSymbols([candidate("Alpha", "class")], "  ")).toEqual([]);
  });
});

describe("mergeResults", () => {
  const sectionPath = "apps/ppp-rl/admin-ui/src/app/pages/administrative-daten/pages/location-detail/components/stammdaten-tab/location-arbeitsstunden-pro-tag-section/location-arbeitsstunden-pro-tag-section.component.ts";
  const files = [sectionPath, "src/validation.ts"];
  const symbols = [candidate("validateUserPassword", "function"), candidate("ValidationPipe", "class")];
  const listing = (query: string) =>
    mergeResults(searchFiles(files, query), rankSymbols(symbols, query)).map((result) => `${resultGroup(result)}: ${result.type === "file" ? result.match.path : result.match.name}`);

  it("puts a symbol named like the query before files that match only loosely", () => {
    expect(listing("validateuserpas")).toEqual(["Symbols: validateUserPassword", `Files: ${sectionPath}`]);
  });

  it("keeps classes, files, symbols on equally good matches", () => {
    expect(listing("valid")).toEqual(["Classes: ValidationPipe", "Files: src/validation.ts", `Files: ${sectionPath}`, "Symbols: validateUserPassword"]);
  });
});
