import { describe, expect, it } from "vitest";
import { scrollTopToReveal, visibleRowRange } from "./virtual-rows.utils";

describe("visibleRowRange", () => {
  it("covers the rows that touch the viewport plus the overscan, rounded out to multiples of it", () => {
    // Rows 10 to 15 touch the viewport; 5 to 20 with the overscan.
    expect(visibleRowRange(240, 100, 24, 1000, 5)).toEqual({ start: 5, end: 20 });
    // Rows 11 to 16 touch it; 6 to 21 with the overscan, rounded out to 5 to 25.
    expect(visibleRowRange(264, 100, 24, 1000, 5)).toEqual({ start: 5, end: 25 });
  });

  it("keeps the range while the scroll stays inside one step of the overscan", () => {
    expect(visibleRowRange(264, 100, 24, 1000, 5)).toEqual(visibleRowRange(300, 100, 24, 1000, 5));
  });

  it("clamps the range at both ends of the list", () => {
    expect(visibleRowRange(0, 100, 24, 1000, 5)).toEqual({ start: 0, end: 10 });
    expect(visibleRowRange(23_900, 100, 24, 1000, 5)).toEqual({ start: 990, end: 1000 });
  });

  it("renders only the first row while the row height is unknown", () => {
    expect(visibleRowRange(0, 100, 0, 30, 5)).toEqual({ start: 0, end: 1 });
    expect(visibleRowRange(0, 100, 0, 0, 5)).toEqual({ start: 0, end: 0 });
  });

  it("stays inside the list when it scrolled past a list that shrank", () => {
    expect(visibleRowRange(10_000, 100, 24, 10, 5)).toEqual({ start: 5, end: 10 });
  });
});

describe("scrollTopToReveal", () => {
  it("keeps the scroll position when the row is fully visible", () => {
    expect(scrollTopToReveal(5, 24, 100, 200)).toBe(100);
  });

  it("aligns a row above the viewport with its top edge", () => {
    expect(scrollTopToReveal(2, 24, 100, 200)).toBe(48);
  });

  it("aligns a row below the viewport with its bottom edge", () => {
    expect(scrollTopToReveal(20, 24, 100, 200)).toBe(304);
  });
});
