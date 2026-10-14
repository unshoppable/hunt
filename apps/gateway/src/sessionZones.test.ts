import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readSessionZones } from "./sessionZones.ts";

describe("readSessionZones", () => {
  const dir = mkdtempSync(join(tmpdir(), "hunt-zones-"));
  const path = join(dir, "session-zones");

  afterEach(() => rmSync(path, { force: true }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the zones in their order, once each, and skips anything that is no zone", () => {
    writeFileSync(path, "europe-west1-c\neurope-west1-b\n\neurope-west1-c\nnot a zone\neurope-west1-d\n");
    expect(readSessionZones("europe-west1-c", path)).toEqual(["europe-west1-c", "europe-west1-b", "europe-west1-d"]);
  });

  it("falls back to the gateway's zone without the file or without a zone in it", () => {
    expect(readSessionZones("europe-west1-c", path)).toEqual(["europe-west1-c"]);
    writeFileSync(path, "\n");
    expect(readSessionZones("europe-west1-c", path)).toEqual(["europe-west1-c"]);
  });
});
