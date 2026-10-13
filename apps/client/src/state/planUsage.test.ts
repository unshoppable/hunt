import { describe, expect, it } from "vitest";
import { REFRESH_INTERVAL_MS, formatTimeUntil, refreshDelay, usageColor } from "./planUsage";

describe("refreshDelay", () => {
  it("starts the first refresh now", () => {
    expect(refreshDelay(null, 1_000)).toBe(0);
  });

  it("waits out the rest of the interval after a recent refresh", () => {
    expect(refreshDelay(10_000, 25_000)).toBe(REFRESH_INTERVAL_MS - 15_000);
  });

  it("starts now once the interval has passed", () => {
    expect(refreshDelay(10_000, 10_000 + REFRESH_INTERVAL_MS + 1)).toBe(0);
  });
});

describe("usageColor", () => {
  it("hits the pastel green, yellow, peach and red at their stops", () => {
    expect(usageColor(0)).toBe("rgb(166 227 161)");
    expect(usageColor(50)).toBe("rgb(249 226 175)");
    expect(usageColor(75)).toBe("rgb(250 179 135)");
    expect(usageColor(100)).toBe("rgb(243 139 168)");
  });

  it("blends between two stops", () => {
    expect(usageColor(25)).toBe("rgb(208 227 168)");
  });

  it("clamps levels outside 0–100", () => {
    expect(usageColor(130)).toBe("rgb(243 139 168)");
    expect(usageColor(-5)).toBe("rgb(166 227 161)");
  });
});

describe("formatTimeUntil", () => {
  const now = Date.parse("2026-10-12T08:00:00Z");

  it("uses the two largest units", () => {
    expect(formatTimeUntil("2026-10-17T21:00:00Z", now)).toBe("5d 13h");
    expect(formatTimeUntil("2026-10-12T11:10:00Z", now)).toBe("3h 10m");
    expect(formatTimeUntil("2026-10-12T08:12:30Z", now)).toBe("12m");
  });

  it("leaves out a zero second unit", () => {
    expect(formatTimeUntil("2026-10-14T08:00:00Z", now)).toBe("2d");
    expect(formatTimeUntil("2026-10-12T11:00:00Z", now)).toBe("3h");
  });

  it("says now for a reset that is due or past", () => {
    expect(formatTimeUntil("2026-10-12T08:00:20Z", now)).toBe("now");
    expect(formatTimeUntil("2026-10-12T07:00:00Z", now)).toBe("now");
  });
});
