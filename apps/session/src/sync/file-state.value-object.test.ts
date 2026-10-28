import { lstatSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileState } from "./file-state.value-object.ts";

const STATE = { size: 2, modifiedNs: "1700000000123456789", executable: false, link: false };

describe("FileState", () => {
  let dir = "";

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("compares every field", () => {
    const state = new FileState(STATE);

    expect(state.isEqualTo(new FileState({ ...STATE }))).toBe(true);
    expect(state.isEqualTo(null)).toBe(false);
    expect(state.isEqualTo(new FileState({ ...STATE, modifiedNs: "1700000000123456790" }))).toBe(false);
    expect(state.isEqualTo(new FileState({ ...STATE, size: 3 }))).toBe(false);
    expect(state.isEqualTo(new FileState({ ...STATE, executable: true }))).toBe(false);
    expect(state.isEqualTo(new FileState({ ...STATE, link: true }))).toBe(false);
  });

  it("reads a file's size, modification time and execute bit and a link's target length from its lstat", () => {
    dir = mkdtempSync(join(tmpdir(), "hunt-file-state-"));
    const script = join(dir, "run.sh");
    writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
    utimesSync(script, 1_700_000_000, 1_700_000_000);
    symlinkSync("run.sh", join(dir, "link"));

    expect(FileState.fromStats(lstatSync(script, { bigint: true }))).toEqual({ size: 10, modifiedNs: "1700000000000000000", executable: true, link: false });
    expect(FileState.fromStats(lstatSync(join(dir, "link"), { bigint: true }))).toMatchObject({ size: 6, link: true });
  });

  it("serializes as the protocol's state", () => {
    expect(JSON.stringify(new FileState(STATE))).toBe('{"size":2,"modifiedNs":"1700000000123456789","executable":false,"link":false}');
  });

  it("rejects a negative size", () => {
    expect(() => new FileState({ ...STATE, size: -1 })).toThrow();
  });

  it("rejects a size that is no whole number", () => {
    expect(() => new FileState({ ...STATE, size: 1.5 })).toThrow();
  });

  it("rejects a modification time that is no decimal string", () => {
    expect(() => new FileState({ ...STATE, modifiedNs: "1.7e18" })).toThrow(/must be a decimal string/);
  });

  it("accepts a modification time before the epoch", () => {
    expect(new FileState({ ...STATE, modifiedNs: "-1000000000" }).modifiedNs).toBe("-1000000000");
  });
});
