import { describe, expect, it } from "vitest";
import { locateExcerpt } from "./code-excerpt.utils";

const PATH = "src/sweep.service.ts";
const FILE = [
  "for (const filePath of files) {",
  "  if (referencedPaths.has(filePath)) continue;",
  "",
  "  try {",
  "    if ((await stat(filePath)).mtimeMs > orphanDeadline) continue;",
  "",
  "    await remove(filePath);",
  "    removedCount++;",
  "  } catch (error) {",
  "    logger.warn(error);",
  "  }",
  "}",
  "await remove(filePath);",
].join("\n");

const at = (startLine: number, endLine = startLine) => ({ path: PATH, startLine, endLine });

describe("locateExcerpt", () => {
  it("moves a place the agent miscounted to the line its code stands on", () => {
    expect(locateExcerpt(FILE, "        await remove(filePath);", at(6))).toStrictEqual(at(7));
  });

  it("keeps a place whose code stands where the agent said", () => {
    expect(locateExcerpt(FILE, "await remove(filePath);", at(13))).toStrictEqual(at(13));
  });

  it("takes the match nearest to the named line when the code stands several times in the file", () => {
    expect(locateExcerpt(FILE, "await remove(filePath);", at(11))).toStrictEqual(at(13));
    expect(locateExcerpt(FILE, "await remove(filePath);", at(9))).toStrictEqual(at(7));
  });

  it("spans the whole excerpt without `…`, whatever end the agent named", () => {
    expect(locateExcerpt(FILE, "await remove(filePath);\nremovedCount++;", at(3, 9))).toStrictEqual(at(7, 8));
  });

  it("matches an excerpt with `…` by its lines before it and moves its end by the same offset", () => {
    const excerpt = "try {\n  …\n} catch (error) {";

    expect(locateExcerpt(FILE, excerpt, at(3, 8))).toStrictEqual(at(4, 9));
  });

  it("keeps the named place when the file holds no such code, or the excerpt only blank lines before its `…`", () => {
    expect(locateExcerpt(FILE, "await unlink(filePath);", at(6))).toStrictEqual(at(6));
    expect(locateExcerpt(FILE, "\n…\n}", at(2, 12))).toStrictEqual(at(2, 12));
  });
});
