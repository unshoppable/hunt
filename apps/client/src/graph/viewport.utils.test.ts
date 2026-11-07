import { describe, expect, it } from "vitest";
import { snapViewport } from "./viewport.utils";

describe("snapViewport", () => {
  it("rounds the pan to whole pixels on a 1x display and keeps the zoom", () => {
    expect(snapViewport({ x: -2874.962749, y: -3610.673261, zoom: 1.4613 }, 1)).toEqual({ x: -2875, y: -3611, zoom: 1.4613 });
  });

  it("rounds the pan to half pixels on a 2x display", () => {
    expect(snapViewport({ x: 10.3, y: -4.8, zoom: 2 }, 2)).toEqual({ x: 10.5, y: -5, zoom: 2 });
  });

  it("leaves a snapped viewport unchanged", () => {
    const snapped = snapViewport({ x: 7.123, y: 3.987, zoom: 0.8 }, 1.5);
    expect(snapViewport(snapped, 1.5)).toEqual(snapped);
  });
});
