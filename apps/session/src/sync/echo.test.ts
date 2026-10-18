import { describe, expect, it } from "vitest";
import { EchoFilter } from "./echo.ts";

const APPLIED = { size: 2, modifiedNs: "1700000000123456000", executable: false, link: false };

describe("EchoFilter", () => {
  it("drops every event that finds the applied state and reports the first that does not", () => {
    const echo = new EchoFilter();
    echo.record("a.txt", APPLIED);

    expect(echo.isEcho("a.txt", { ...APPLIED })).toBe(true);
    expect(echo.isEcho("a.txt", { ...APPLIED })).toBe(true);
    expect(echo.isEcho("a.txt", { ...APPLIED, size: 3 })).toBe(false);
    // The record is gone once another state was reported.
    expect(echo.isEcho("a.txt", { ...APPLIED })).toBe(false);
  });

  it("drops the event of an applied deletion until the file comes back", () => {
    const echo = new EchoFilter();
    echo.record("b.txt", null);

    expect(echo.isEcho("b.txt", null)).toBe(true);
    expect(echo.isEcho("b.txt", APPLIED)).toBe(false);
    expect(echo.isEcho("b.txt", null)).toBe(false);
  });

  it("reports paths it has no record of", () => {
    expect(new EchoFilter().isEcho("c.txt", null)).toBe(false);
  });
});
