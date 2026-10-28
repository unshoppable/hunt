import { describe, expect, it } from "vitest";
import { insertImageReference, removeImageReference, shiftImageReferences } from "./image-references.utils";

describe("insertImageReference", () => {
  it("inserts at the caret with a space on each side", () => {
    expect(insertImageReference("look at this", 7, 1)).toEqual({ text: "look at [Image #1] this", caret: 18 });
  });

  it("adds no space at the start, after whitespace or before whitespace", () => {
    expect(insertImageReference("", 0, 1)).toEqual({ text: "[Image #1] ", caret: 11 });
    expect(insertImageReference("look ", 5, 2)).toEqual({ text: "look [Image #2] ", caret: 16 });
    expect(insertImageReference("look\nhere", 4, 1)).toEqual({ text: "look [Image #1]\nhere", caret: 15 });
  });
});

describe("removeImageReference", () => {
  it("removes the reference and renumbers the later ones", () => {
    expect(removeImageReference("a [Image #1] b [Image #2] c [Image #3]", 2)).toBe("a [Image #1] b c [Image #2]");
  });

  it("removes every mention and the trailing space at the end", () => {
    expect(removeImageReference("[Image #1] see [Image #1] ", 1)).toBe("see");
  });

  it("leaves text without the reference alone", () => {
    expect(removeImageReference("plain [Image #10]", 1)).toBe("plain [Image #9]");
    expect(removeImageReference("plain", 1)).toBe("plain");
  });
});

describe("shiftImageReferences", () => {
  it("adds the offset to every reference", () => {
    expect(shiftImageReferences("[Image #1] and [Image #2]", 2)).toBe("[Image #3] and [Image #4]");
    expect(shiftImageReferences("[Image #1]", 0)).toBe("[Image #1]");
  });
});
