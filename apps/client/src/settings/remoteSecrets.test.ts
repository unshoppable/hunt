import { describe, expect, it } from "vitest";
import { maskedRemoteSecret, normalizeRemoteSecretName, remoteSecretNameProblem, remoteSecretValueProblem } from "./remoteSecrets";

describe("remoteSecretNameProblem", () => {
  it("accepts the names the gateway accepts", () => {
    for (const name of ["A", "MED_OPENAI_API_KEY", "X9_", `A${"B".repeat(63)}`]) {
      expect(remoteSecretNameProblem(name, [])).toBeNull();
    }
  });

  it("refuses other names and asks nothing of an empty one", () => {
    for (const name of ["_A", "9A", "med_key", "A-B", "ÄB", `A${"B".repeat(64)}`]) {
      expect(remoteSecretNameProblem(name, [])).toMatch(/^Start with a letter/);
    }
    expect(remoteSecretNameProblem("", [])).toBeNull();
  });

  it("points an existing name to its row", () => {
    expect(remoteSecretNameProblem("MED_KEY", ["MED_KEY"])).toBe("MED_KEY exists already; replace its value in the list.");
  });
});

describe("remoteSecretValueProblem", () => {
  it("accepts single-line values up to 8192 characters", () => {
    expect(remoteSecretValueProblem("sk-1")).toBeNull();
    expect(remoteSecretValueProblem("ä".repeat(8192))).toBeNull();
    expect(remoteSecretValueProblem("")).toBeNull();
  });

  it("refuses line breaks, NUL and longer values without repeating them", () => {
    for (const value of ["sk-1\nsk-2", "sk-1\r", "sk\0"]) {
      expect(remoteSecretValueProblem(value)).toBe("The value must hold no line break and no NUL character.");
    }
    expect(remoteSecretValueProblem("a".repeat(8193))).toBe("The value is longer than 8192 characters.");
  });
});

describe("normalizeRemoteSecretName and maskedRemoteSecret", () => {
  it("uppercases a typed name and masks a value behind its hint", () => {
    expect(normalizeRemoteSecretName(" med_openai_key ")).toBe("MED_OPENAI_KEY");
    expect(maskedRemoteSecret("x9Qz")).toBe("••••••••x9Qz");
    expect(maskedRemoteSecret("")).toBe("••••••••");
  });
});
