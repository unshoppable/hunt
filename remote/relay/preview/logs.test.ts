import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogFile, logPath, readLogTail } from "./logs.ts";

let dir = "";
let path = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hunt-logs-"));
  path = join(dir, "web.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("logPath", () => {
  it("puts a log into the logs folder of the state directory", () => {
    expect(logPath("/run/hunt/socket/preview", "web")).toBe("/run/hunt/socket/preview/logs/web.log");
  });
});

describe("LogFile", () => {
  it("appends text and bytes and continues the file when it is opened again", () => {
    const first = new LogFile(path);
    first.write("one\n");
    first.write(Buffer.from("two\n"));
    first.write("");
    first.close();
    const second = new LogFile(path);
    second.write(new TextEncoder().encode("three\n"));
    second.close();

    expect(read(path)).toBe("one\ntwo\nthree\n");
  });

  it("starts a line of its own after output without a line break, and only then", () => {
    const log = new LogFile(path);
    log.line("first note");
    log.write("partial output");
    log.line("second note");
    log.write("complete output\n");
    log.line("third note");
    log.close();

    expect(read(path)).toBe("first note\npartial output\nsecond note\ncomplete output\nthird note\n");
  });

  it("checks whether a file it opens ends with a line break", () => {
    writeFileSync(path, "output without a line break");
    const log = new LogFile(path);
    log.line("note");
    log.close();
    const again = new LogFile(path);
    again.line("another note");
    again.close();

    expect(read(path)).toBe("output without a line break\nnote\nanother note\n");
  });

  it("moves the file to .1 when a write would grow it past maxBytes, replacing an older .1", () => {
    const log = new LogFile(path, { maxBytes: 10 });
    log.write("12345\n");
    log.write("abcd\n");
    expect([read(`${path}.1`), read(path)]).toEqual(["12345\n", "abcd\n"]);

    log.write("efgh\n");
    log.write("ijkl\n");
    log.close();

    expect([read(`${path}.1`), read(path)]).toEqual(["abcd\nefgh\n", "ijkl\n"]);
  });

  it("starts a line that moves the file to .1 at the top of the new file", () => {
    const log = new LogFile(path, { maxBytes: 10 });
    log.write("partial");
    log.line("note");
    log.close();

    expect([read(`${path}.1`), read(path)]).toEqual(["partial", "note\n"]);
  });

  it("writes a chunk larger than maxBytes into an empty file whole", () => {
    const log = new LogFile(path, { maxBytes: 10 });
    log.write("0123456789abcdef\n");
    log.close();

    expect(read(path)).toBe("0123456789abcdef\n");
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it("reports the first of a run of failed writes, and again once a write succeeded in between", () => {
    const folder = join(dir, "logs");
    const nested = join(folder, "web.log");
    const errors: string[] = [];
    const log = new LogFile(nested, { onError: (message) => errors.push(message) });

    log.write("lost\n");
    log.write("lost as well\n");
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`failed to write ${nested}: `)).toBe(true);
    expect(errors[0]).toContain("ENOENT");

    mkdirSync(folder);
    log.write("kept\n");
    expect(read(nested)).toBe("kept\n");
    log.close();
    rmSync(folder, { recursive: true });
    log.write("lost again\n");

    expect(errors).toHaveLength(2);
  });
});

describe("readLogTail", () => {
  it("returns the last lines of a log", () => {
    writeFileSync(path, "1\n2\n3\n4\n5\n");

    expect(readLogTail(path, 2)).toEqual(["4", "5"]);
    expect(readLogTail(path, 5)).toEqual(["1", "2", "3", "4", "5"]);
    expect(readLogTail(path, 50)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("keeps a last line that has no line break yet", () => {
    writeFileSync(path, "a\nb\nc");

    expect(readLogTail(path, 2)).toEqual(["b", "c"]);
  });

  it("continues into the rotated file when the log holds fewer lines", () => {
    writeFileSync(`${path}.1`, "old 1\nold 2\nold 3\n");
    writeFileSync(path, "new 1\n");

    expect(readLogTail(path, 3)).toEqual(["old 2", "old 3", "new 1"]);
    expect(readLogTail(path, 10)).toEqual(["old 1", "old 2", "old 3", "new 1"]);
    writeFileSync(path, "");
    expect(readLogTail(path, 2)).toEqual(["old 2", "old 3"]);
  });

  it("returns null when the log does not exist", () => {
    writeFileSync(`${path}.1`, "only the rotated file\n");

    expect(readLogTail(path, 5)).toBeNull();
    expect(readLogTail(join(dir, "none.log"), 5)).toBeNull();
  });

  it("reads lines across the chunks it reads backwards, also where a chunk boundary splits a character", () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `${String(index).padStart(4, "0")} ${"ä".repeat(28)}`);
    writeFileSync(path, `${lines.join("\n")}\n`);

    expect(readLogTail(path, 3)).toEqual(lines.slice(-3));
    expect(readLogTail(path, 1100)).toEqual(lines.slice(-1100));
    expect(readLogTail(path, 5000)).toEqual(lines);
  });
});
