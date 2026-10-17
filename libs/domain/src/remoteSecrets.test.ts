import { describe, expect, it } from "vitest";
import { MAX_REMOTE_SECRETS, parseRemoteSecrets, remoteSecretHint, remoteSecretNameProblem, remoteSecretValueProblem } from "./remoteSecrets.ts";

describe("remote secret rules", () => {
  it("accepts upper-case names of up to 64 characters", () => {
    expect(remoteSecretNameProblem("MED_OPENAI_API_KEY")).toBeNull();
    expect(remoteSecretNameProblem(`A${"9".repeat(63)}`)).toBeNull();
    for (const name of ["", "med_key", "1KEY", "KEY-1", `A${"B".repeat(64)}`, 7]) {
      expect(remoteSecretNameProblem(name)).toMatch(/^the name must match/);
    }
  });

  it("accepts single-line values of up to 8192 characters", () => {
    expect(remoteSecretValueProblem("sk-123")).toBeNull();
    expect(remoteSecretValueProblem("x".repeat(8192))).toBeNull();
    expect(remoteSecretValueProblem("😀".repeat(8192))).toBeNull();
    expect(remoteSecretValueProblem("")).toBe("the value must be a non-empty string");
    expect(remoteSecretValueProblem(null)).toBe("the value must be a non-empty string");
    expect(remoteSecretValueProblem("x".repeat(8193))).toBe("the value must have at most 8192 characters");
    expect(remoteSecretValueProblem("a\nb")).toBe("the value must be a single line");
    expect(remoteSecretValueProblem("a\0b")).toBe("the value must be a single line");
  });

  it("hints at long values only", () => {
    expect(remoteSecretHint("sk-proj-abcdefgh1234")).toBe("1234");
    expect(remoteSecretHint("short-value")).toBe("");
  });
});

describe("parseRemoteSecrets", () => {
  it("reads the stored object", () => {
    expect(parseRemoteSecrets('{"MED_OPENAI_API_KEY": "sk-1", "OTHER": "x y"}')).toEqual({ MED_OPENAI_API_KEY: "sk-1", OTHER: "x y" });
    expect(parseRemoteSecrets("{}")).toEqual({});
  });

  it("rejects anything else without quoting a value", () => {
    expect(() => parseRemoteSecrets("sk-secret")).toThrow("the remote secrets are no valid JSON");
    expect(() => parseRemoteSecrets('["sk-secret"]')).toThrow("the remote secrets are no JSON object");
    expect(() => parseRemoteSecrets('{"lower": "sk-secret"}')).toThrow('the remote secret "lower" is invalid: the name must match');
    expect(() => parseRemoteSecrets('{"KEY": "sk\\nsecret"}')).toThrow('the remote secret "KEY" is invalid: the value must be a single line');
    const many = Object.fromEntries(Array.from({ length: MAX_REMOTE_SECRETS + 1 }, (_, index) => [`K${index}`, "v"]));
    expect(() => parseRemoteSecrets(JSON.stringify(many))).toThrow("there are more than 256 remote secrets");
  });
});
