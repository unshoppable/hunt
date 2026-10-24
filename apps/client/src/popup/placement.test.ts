import { describe, expect, it } from "vitest";
import { fitIntoWorkArea, popupBounds } from "./placement";

const PAGE = { x: 100, y: 50, width: 1500, height: 950 };
const SIZE = { width: 1040, height: 600 };

describe("popupBounds", () => {
  it("puts the top-left corner at a point of the page", () => {
    expect(popupBounds({ x: 320.4, y: 200.6 }, PAGE, SIZE)).toEqual({ x: 420, y: 251, width: 1040, height: 600 });
  });

  it("centers the window on the page", () => {
    expect(popupBounds("center", PAGE, SIZE)).toEqual({ x: 330, y: 225, width: 1040, height: 600 });
  });

  it("centers the window horizontally near the top of the page", () => {
    expect(popupBounds("top", PAGE, SIZE)).toEqual({ x: 330, y: 126, width: 1040, height: 600 });
  });
});

describe("fitIntoWorkArea", () => {
  const LAPTOP = { x: 0, y: 25, width: 1512, height: 920 };
  const MONITOR = { x: 1512, y: -300, width: 2560, height: 1415 };

  it("keeps a window that fits", () => {
    const bounds = { x: 200, y: 100, width: 800, height: 500 };
    expect(fitIntoWorkArea(bounds, [LAPTOP, MONITOR])).toEqual(bounds);
  });

  it("moves a window that sticks out of its area back inside", () => {
    expect(fitIntoWorkArea({ x: 1000, y: 700, width: 800, height: 500 }, [LAPTOP, MONITOR])).toEqual({ x: 712, y: 445, width: 800, height: 500 });
  });

  it("uses the area that holds the top-left corner", () => {
    expect(fitIntoWorkArea({ x: 3800, y: 900, width: 800, height: 500 }, [LAPTOP, MONITOR])).toEqual({ x: 3272, y: 615, width: 800, height: 500 });
  });

  it("moves a window outside every area into the nearest one", () => {
    expect(fitIntoWorkArea({ x: -400, y: 10, width: 300, height: 200 }, [LAPTOP, MONITOR])).toEqual({ x: 0, y: 25, width: 300, height: 200 });
  });

  it("shrinks a window larger than its area", () => {
    expect(fitIntoWorkArea({ x: 10, y: 30, width: 2000, height: 1200 }, [LAPTOP])).toEqual({ x: 0, y: 25, width: 1512, height: 920 });
  });

  it("keeps the bounds without areas", () => {
    const bounds = { x: -5, y: -5, width: 100, height: 100 };
    expect(fitIntoWorkArea(bounds, [])).toEqual(bounds);
  });
});
