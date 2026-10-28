import { describe, expect, it } from "vitest";
import { formatMessageTime } from "./message-time.utils";

const now = new Date(2026, 9, 20, 14, 5);
const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

describe("formatMessageTime", () => {
  it("shows the time alone for a message of today", () => {
    expect(formatMessageTime(at(2026, 9, 20, 8, 22), now, "de-DE")).toBe("08:22");
  });

  it("puts day and month before the time of an earlier day, and the year of an earlier year", () => {
    expect(formatMessageTime(at(2026, 9, 19, 23, 59), now, "de-DE")).toBe("19.10., 23:59");
    expect(formatMessageTime(at(2025, 11, 31, 9, 0), now, "de-DE")).toBe("31.12.25, 09:00");
  });
});
