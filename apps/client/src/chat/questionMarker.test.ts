import { describe, expect, it } from "vitest";
import { hasQuestionMarker } from "./questionMarker";

describe("hasQuestionMarker", () => {
  it("finds the marker at the end of a reply, whitespace aside", () => {
    expect(hasQuestionMarker("Which one?\n<!-- hunt:question -->")).toBe(true);
    expect(hasQuestionMarker("Which one?\n\n<!--hunt:question-->\n")).toBe(true);
    expect(hasQuestionMarker("Pick A or B.\n<!--  hunt:question  -->  \n\n")).toBe(true);
  });

  it("ignores a marker that is not at the end, other markers and plain questions", () => {
    expect(hasQuestionMarker("<!-- hunt:question -->\nI pushed the branch.")).toBe(false);
    expect(hasQuestionMarker("Done.\n<!-- hunt:guardrail rule: x -->")).toBe(false);
    expect(hasQuestionMarker("Shall I push?")).toBe(false);
    expect(hasQuestionMarker("")).toBe(false);
  });
});
