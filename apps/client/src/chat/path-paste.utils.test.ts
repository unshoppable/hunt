import { describe, expect, it } from "vitest";
import { pastedPaths } from "./path-paste.utils";

describe("pastedPaths", () => {
  it("reads an absolute path with spaces", () => {
    expect(pastedPaths("/Users/me/Screenshots/Bildschirmfoto 2026-11-12 um 13.27.47.png")).toEqual(["/Users/me/Screenshots/Bildschirmfoto 2026-11-12 um 13.27.47.png"]);
  });

  it("reads one path per line and ignores blank lines and surrounding space", () => {
    expect(pastedPaths("  /tmp/a.png\r\n\n/tmp/b.png\n")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  });

  it("reads quoted, escaped and file URL forms", () => {
    expect(pastedPaths("'/tmp/a b.png'")).toEqual(["/tmp/a b.png"]);
    expect(pastedPaths('"/tmp/a b.png"')).toEqual(["/tmp/a b.png"]);
    expect(pastedPaths("/tmp/a\\ b.png")).toEqual(["/tmp/a b.png"]);
    expect(pastedPaths("file:///tmp/a%20b.png")).toEqual(["/tmp/a b.png"]);
    expect(pastedPaths("file://localhost/tmp/a.png")).toEqual(["/tmp/a.png"]);
  });

  it("gives nothing when any line is not an absolute path", () => {
    expect(pastedPaths("")).toEqual([]);
    expect(pastedPaths("look at /tmp/a.png")).toEqual([]);
    expect(pastedPaths("/tmp/a.png\nand this")).toEqual([]);
    expect(pastedPaths("src/a.png")).toEqual([]);
    expect(pastedPaths("file://other-host/tmp/a.png")).toEqual([]);
    expect(pastedPaths("file:///tmp/%E0%A4%A.png")).toEqual([]);
  });
});
