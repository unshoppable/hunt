import { describe, expect, it } from "vitest";
import { fillPrompt } from "./prompts.ts";

describe("fillPrompt", () => {
  it("replaces every placeholder and refuses one without a value", () => {
    expect(fillPrompt("Issue #{{number}} of {{repo}}, #{{number}}", { number: "3", repo: "acme/app" })).toBe("Issue #3 of acme/app, #3");
    expect(() => fillPrompt("{{missing}}", {})).toThrow("failed to fill the prompt: no value for {{missing}}");
  });

  it("leaves placeholders inside the values alone", () => {
    expect(fillPrompt("Output:\n{{output}}", { output: "expected {{name}}" })).toBe("Output:\nexpected {{name}}");
  });
});
