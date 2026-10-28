import { describe, expect, it } from "vitest";
import { filterOptions, findTypeahead, placeMenu, stepEnabled, type DropdownOption } from "./floating-menu.utils";

const VIEWPORT = { width: 1000, height: 800 };

const options: DropdownOption[] = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium", isDisabled: true },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra High" },
  { id: "max", name: "Max" },
];

describe("placeMenu", () => {
  it("opens below the anchor, left-aligned, when the menu fits there", () => {
    expect(placeMenu({ left: 100, top: 100, bottom: 132 }, { width: 200, height: 300 }, VIEWPORT)).toEqual({ left: 100, top: 138, maxHeight: 654, isAbove: false });
  });

  it("opens above an anchor near the bottom edge", () => {
    expect(placeMenu({ left: 100, top: 700, bottom: 732 }, { width: 200, height: 300 }, VIEWPORT)).toEqual({ left: 100, top: 394, maxHeight: 686, isAbove: true });
  });

  it("stays below when the room above is smaller and caps the height to the room below", () => {
    expect(placeMenu({ left: 100, top: 300, bottom: 332 }, { width: 200, height: 600 }, VIEWPORT)).toEqual({ left: 100, top: 338, maxHeight: 454, isAbove: false });
  });

  it("caps an upward menu to the room above and puts it at the top margin", () => {
    expect(placeMenu({ left: 100, top: 500, bottom: 532 }, { width: 200, height: 900 }, VIEWPORT)).toEqual({ left: 100, top: 8, maxHeight: 486, isAbove: true });
  });

  it("keeps a forced side even when the other one has more room", () => {
    expect(placeMenu({ left: 100, top: 700, bottom: 732 }, { width: 200, height: 300 }, VIEWPORT, false)).toEqual({ left: 100, top: 738, maxHeight: 54, isAbove: false });
  });

  it("shifts left to stay inside the window", () => {
    expect(placeMenu({ left: 900, top: 100, bottom: 132 }, { width: 200, height: 100 }, VIEWPORT).left).toBe(792);
    expect(placeMenu({ left: -20, top: 100, bottom: 132 }, { width: 200, height: 100 }, VIEWPORT).left).toBe(8);
  });
});

describe("stepEnabled", () => {
  it("skips disabled options and stops at the ends", () => {
    expect(stepEnabled(options, 0, 1)).toBe(2);
    expect(stepEnabled(options, 2, -1)).toBe(0);
    expect(stepEnabled(options, 4, 1)).toBe(4);
    expect(stepEnabled(options, 0, -1)).toBe(0);
  });

  it("finds the first and the last enabled option from outside the list", () => {
    expect(stepEnabled(options, -1, 1)).toBe(0);
    expect(stepEnabled(options, options.length, -1)).toBe(4);
    expect(stepEnabled([{ id: "a", name: "A", isDisabled: true }], -1, 1)).toBe(-1);
  });
});

describe("findTypeahead", () => {
  it("cycles through the options starting with a repeated letter", () => {
    expect(findTypeahead(options, "m", -1)).toBe(4);
    expect(findTypeahead(options, "h", 0)).toBe(2);
    expect(findTypeahead(options, "h", 2)).toBe(2);
  });

  it("refines the current match while typing on and ignores case", () => {
    expect(findTypeahead(options, "ex", 3)).toBe(3);
    expect(findTypeahead(options, "EXTRA", 0)).toBe(3);
    expect(findTypeahead(options, "zz", 0)).toBe(-1);
  });
});

describe("filterOptions", () => {
  it("matches name or ID, case-insensitive, and keeps everything for a blank query", () => {
    expect(filterOptions(options, "HIGH").map((option) => option.id)).toEqual(["high", "xhigh"]);
    expect(filterOptions(options, "xh").map((option) => option.id)).toEqual(["xhigh"]);
    expect(filterOptions(options, "  ")).toBe(options);
  });
});
