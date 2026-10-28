import { describe, expect, it } from "vitest";
import { shouldFollow } from "./follow-scroll.utils";

const VIEW = { scrollHeight: 2000, clientHeight: 500 };

describe("shouldFollow", () => {
  it("follows while the view sits at the end, including subpixel offsets", () => {
    expect(shouldFollow(true, 1400, false, { ...VIEW, scrollTop: 1500 })).toBe(true);
    expect(shouldFollow(true, 1500, false, { ...VIEW, scrollTop: 1499.5 })).toBe(true);
  });

  it("stops following when the user drags up away from the end", () => {
    expect(shouldFollow(true, 1500, true, { ...VIEW, scrollTop: 1450 })).toBe(false);
  });

  it("keeps following when layout moves the offset up, also when the content grew before the scroll event", () => {
    expect(shouldFollow(true, 1500, false, { ...VIEW, scrollTop: 1450 })).toBe(true);
    expect(shouldFollow(true, 1500, false, { scrollHeight: 2100, clientHeight: 500, scrollTop: 1470 })).toBe(true);
  });

  it("keeps the state while the user scrolls down without reaching the end", () => {
    expect(shouldFollow(false, 600, true, { ...VIEW, scrollTop: 900 })).toBe(false);
    expect(shouldFollow(false, 600, false, { ...VIEW, scrollTop: 900 })).toBe(false);
  });

  it("follows again once the user scrolls back to the end", () => {
    expect(shouldFollow(false, 1300, false, { ...VIEW, scrollTop: 1500 })).toBe(true);
    expect(shouldFollow(false, 1300, true, { ...VIEW, scrollTop: 1494 })).toBe(true);
  });

  it("treats the clamp after shrinking content as staying at the end", () => {
    expect(shouldFollow(true, 1500, false, { scrollHeight: 1200, clientHeight: 500, scrollTop: 700 })).toBe(true);
    expect(shouldFollow(true, 1500, false, { scrollHeight: 400, clientHeight: 500, scrollTop: 0 })).toBe(true);
  });
});
