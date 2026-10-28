import { describe, expect, it } from "vitest";
import { MAX_REMOTE_SECRETS, parseRemoteSecrets } from "./remote-secrets.utils.ts";

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
