import { describe, expect, it } from "vitest";
import { formatElapsed } from "./working-indicator.utils";

describe("formatElapsed", () => {
  it("shows seconds below a minute and minutes with seconds from one on", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(2485)).toBe("41m 25s");
  });
});
