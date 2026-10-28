import { describe, expect, it } from "vitest";
import { RemoteSecret } from "./remote-secret.value-object.ts";

describe("RemoteSecret", () => {
  it("accepts upper-case names of up to 64 characters", () => {
    expect(RemoteSecret.nameProblem("MED_OPENAI_API_KEY")).toBeNull();
    expect(RemoteSecret.nameProblem(`A${"9".repeat(63)}`)).toBeNull();
    for (const name of ["", "med_key", "1KEY", "KEY-1", `A${"B".repeat(64)}`, 7]) {
      expect(RemoteSecret.nameProblem(name)).toMatch(/^the name must match/);
    }
  });

  it("accepts single-line values of up to 8192 characters", () => {
    expect(RemoteSecret.valueProblem("sk-123")).toBeNull();
    expect(RemoteSecret.valueProblem("x".repeat(8192))).toBeNull();
    expect(RemoteSecret.valueProblem("😀".repeat(8192))).toBeNull();
    expect(RemoteSecret.valueProblem("")).toBe("the value must be a non-empty string");
    expect(RemoteSecret.valueProblem(null)).toBe("the value must be a non-empty string");
    expect(RemoteSecret.valueProblem("x".repeat(8193))).toBe("the value must have at most 8192 characters");
    expect(RemoteSecret.valueProblem("a\nb")).toBe("the value must be a single line");
    expect(RemoteSecret.valueProblem("a\0b")).toBe("the value must be a single line");
  });

  it("rejects an invalid name or value at construction", () => {
    expect(() => new RemoteSecret({ name: "lower", value: "sk-1" })).toThrow(/the name must match/);
    expect(() => new RemoteSecret({ name: "KEY", value: "" })).toThrow("the value must be a non-empty string");
  });

  it("hints at long values only and summarizes without the value", () => {
    expect(new RemoteSecret({ name: "KEY", value: "sk-proj-abcdefgh1234" }).hint).toBe("1234");
    expect(new RemoteSecret({ name: "KEY", value: "short-value" }).hint).toBe("");
    expect(new RemoteSecret({ name: "KEY", value: "sk-proj-abcdefgh1234" }).summary()).toEqual({ name: "KEY", hint: "1234" });
  });
});
