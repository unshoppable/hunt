import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./ScreenshotPicker";

const NOW = Date.parse("2026-10-10T12:00:00Z");

describe("formatRelativeTime", () => {
  it("rounds to the largest fitting unit", () => {
    expect(formatRelativeTime(NOW - 20_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 hours ago");
    expect(formatRelativeTime(NOW - 26 * 3_600_000, NOW)).toBe("yesterday");
    expect(formatRelativeTime(NOW - 20 * 86_400_000, NOW)).toBe("3 weeks ago");
    expect(formatRelativeTime(NOW - 400 * 86_400_000, NOW)).toBe("last year");
  });

  it("never reports the future for clock skew", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("just now");
  });
});
