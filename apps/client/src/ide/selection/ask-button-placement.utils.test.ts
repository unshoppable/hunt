import { describe, expect, it } from "vitest";
import { ASK_BUTTON_GAP_PX, ASK_BUTTON_PX, askButtonPlacement } from "./ask-button-placement.utils";

describe("askButtonPlacement", () => {
  it("sits right of the end of a forward selection regardless of the column", () => {
    expect(askButtonPlacement(true, 0)).toBe("after");
    expect(askButtonPlacement(true, 400)).toBe("after");
  });

  it("sits left of the start of a backward selection when the button fits before it", () => {
    expect(askButtonPlacement(false, ASK_BUTTON_PX + ASK_BUTTON_GAP_PX)).toBe("before");
    expect(askButtonPlacement(false, 300)).toBe("before");
  });

  it("moves above the start of a backward selection near the left edge or on an unrendered line", () => {
    expect(askButtonPlacement(false, ASK_BUTTON_PX + ASK_BUTTON_GAP_PX - 1)).toBe("above");
    expect(askButtonPlacement(false, 0)).toBe("above");
    expect(askButtonPlacement(false, -1)).toBe("above");
  });
});
