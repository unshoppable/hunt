import { describe, expect, it } from "vitest";
import { usageColor } from "./usage-color.utils";

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
