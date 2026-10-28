import { describe, expect, it } from "vitest";
import { REFRESH_INTERVAL_MS, formatTimeUntil, refreshDelay } from "./plan-usage.store";

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
