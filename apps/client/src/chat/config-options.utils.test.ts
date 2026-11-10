import { describe, expect, it } from "vitest";
import { listChoiceOptions, type SelectConfigOption } from "./config-options.utils";

const choices = [
  { value: "default", name: "Default (recommended)" },
  { value: "fable", name: "Fable 5.2" },
  { value: "claude-fable-5-1", name: "Fable 5.1" },
  { value: "claude-opus-4-8", name: "Opus 4.8" },
];

function select(id: string, currentValue: string): SelectConfigOption {
  return { id, name: id, type: "select", currentValue, options: choices };
}

describe("listChoiceOptions", () => {
  it("offers the models the agent lists by alias, an older version only while the session runs on it", () => {
    expect(listChoiceOptions(select("model", "fable")).map((choice) => choice.id)).toEqual(["default", "fable"]);
    expect(listChoiceOptions(select("model", "claude-opus-4-8")).map((choice) => choice.id)).toEqual(["default", "fable", "claude-opus-4-8"]);
  });

  it("offers every choice of other options", () => {
    expect(listChoiceOptions(select("effort", "fable"))).toHaveLength(choices.length);
  });
});
