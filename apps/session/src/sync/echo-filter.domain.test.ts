import { describe, expect, it } from "vitest";
import { EchoFilter } from "./echo-filter.domain.ts";
import { FileState } from "./file-state.value-object.ts";

const APPLIED = { size: 2, modifiedNs: "1700000000123456000", executable: false, link: false };

describe("EchoFilter", () => {
  it("drops every event that finds the applied state and reports the first that does not", () => {
    const echo = EchoFilter.start();
    echo.record("a.txt", new FileState(APPLIED));

    expect(echo.isEcho("a.txt", new FileState({ ...APPLIED }))).toBe(true);
    expect(echo.isEcho("a.txt", new FileState({ ...APPLIED }))).toBe(true);
    expect(echo.isEcho("a.txt", new FileState({ ...APPLIED, size: 3 }))).toBe(false);
    // The record is gone once another state was reported.
    expect(echo.isEcho("a.txt", new FileState({ ...APPLIED }))).toBe(false);
  });

  it("drops the event of an applied deletion until the file comes back", () => {
    const echo = EchoFilter.start();
    echo.record("b.txt", null);

    expect(echo.isEcho("b.txt", null)).toBe(true);
    expect(echo.isEcho("b.txt", new FileState(APPLIED))).toBe(false);
    expect(echo.isEcho("b.txt", null)).toBe(false);
  });

  it("reports paths it has no record of", () => {
    expect(EchoFilter.start().isEcho("c.txt", null)).toBe(false);
  });

  it("reports a written file that is gone and forgets its record", () => {
    const echo = EchoFilter.start();
    echo.record("d.txt", new FileState(APPLIED));

    expect(echo.isEcho("d.txt", null)).toBe(false);
    expect(echo.applied.has("d.txt")).toBe(false);
  });

  it("keeps the latest record of a path the client changed twice", () => {
    const echo = EchoFilter.start();
    echo.record("e.txt", new FileState(APPLIED));
    echo.record("e.txt", new FileState({ ...APPLIED, size: 5 }));

    expect(echo.isEcho("e.txt", new FileState({ ...APPLIED, size: 5 }))).toBe(true);
    expect(echo.isEcho("e.txt", new FileState(APPLIED))).toBe(false);
  });

  it("rejects a construction without a map of applied states", () => {
    expect(() => new EchoFilter({ applied: {} as Map<string, FileState | null> })).toThrow();
  });
});
