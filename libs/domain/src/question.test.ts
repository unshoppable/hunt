import { describe, expect, it } from "vitest";
import { asksQuestion, endsWithQuestion, hasQuestionMarker } from "./question.ts";

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

describe("endsWithQuestion", () => {
  it("ends with a question when the last paragraph does, markdown emphasis and quotes aside", () => {
    expect(endsWithQuestion("Shall I also rename the column?")).toBe(true);
    expect(endsWithQuestion("Done.\n\n**Shall I push the branch?**\n")).toBe(true);
    expect(endsWithQuestion("Which one do you prefer (A or B)?")).toBe(true);
    expect(endsWithQuestion("Should I keep `legacy`?")).toBe(true);
    expect(endsWithQuestion("Shall I push? I committed the change meanwhile.")).toBe(false);
    expect(endsWithQuestion("I pushed the branch.")).toBe(false);
    expect(endsWithQuestion("")).toBe(false);
  });
});

describe("asksQuestion", () => {
  it("takes the marker and a trailing question mark alike", () => {
    expect(asksQuestion("Pick A or B.\n<!-- hunt:question -->")).toBe(true);
    expect(asksQuestion("Shall I push?")).toBe(true);
    expect(asksQuestion("I pushed the branch.")).toBe(false);
  });
});
