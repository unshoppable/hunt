import { describe, expect, it } from "vitest";
import { DEFAULT_MODE_ID, HuntSessionConfig } from "./hunt-session-config.value-object.ts";

describe("HuntSessionConfig.fromJson", () => {
  it("reads every field", () => {
    const text = JSON.stringify({
      huntSessionId: "7c0c6f2e",
      acpSessionId: "acp-1",
      cwd: "/srv/worktrees/7c0c6f2e",
      systemPromptAppend: "Commit locally only.",
      modeId: "acceptEdits",
      configOptions: { model: "opus", effort: "high" },
    });

    expect(HuntSessionConfig.fromJson(text)).toEqual({
      acpSessionId: "acp-1",
      cwd: "/srv/worktrees/7c0c6f2e",
      systemPromptAppend: "Commit locally only.",
      modeId: "acceptEdits",
      configOptions: { model: "opus", effort: "high" },
    });
  });

  it("fills in the defaults and reads a null or empty acpSessionId as a new session", () => {
    const expected = { acpSessionId: null, cwd: "/w", systemPromptAppend: "", modeId: DEFAULT_MODE_ID, configOptions: {} };

    expect(HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w" }))).toEqual(expected);
    expect(HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", acpSessionId: null, modeId: "" }))).toEqual(expected);
    expect(HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", acpSessionId: "" }))).toEqual(expected);
  });

  it("rejects a file without a cwd or with values of the wrong type", () => {
    expect(() => HuntSessionConfig.fromJson("[]")).toThrow("expected a JSON object");
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ acpSessionId: "acp-1" }))).toThrow("cwd must be a non-empty string");
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", acpSessionId: 7 }))).toThrow("acpSessionId must be a string or null");
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", configOptions: ["opus"] }))).toThrow("configOptions must be an object");
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", configOptions: { fast: true } }))).toThrow("configOptions.fast must be a string");
  });

  it("rejects an empty cwd", () => {
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ cwd: "" }))).toThrow(/^cwd must be a non-empty string$/);
  });

  it("rejects a systemPromptAppend that is no string", () => {
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", systemPromptAppend: ["a"] }))).toThrow(/^systemPromptAppend must be a string$/);
  });

  it("rejects a modeId that is no string", () => {
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", modeId: 1 }))).toThrow(/^modeId must be a string$/);
  });

  it("reports the first broken rule in the order cwd, acpSessionId, systemPromptAppend, modeId, configOptions", () => {
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ modeId: 1, acpSessionId: 7 }))).toThrow(/^cwd must be a non-empty string$/);
    expect(() => HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", configOptions: [], modeId: 1 }))).toThrow(/^modeId must be a string$/);
  });

  it("passes on the error of text that is no JSON", () => {
    expect(() => HuntSessionConfig.fromJson("{")).toThrow(SyntaxError);
  });

  it("takes every falsy optional value as absent", () => {
    const config = HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", systemPromptAppend: 0, modeId: false, configOptions: null }));

    expect(config).toEqual({ acpSessionId: null, cwd: "/w", systemPromptAppend: "", modeId: DEFAULT_MODE_ID, configOptions: {} });
  });
});

describe("HuntSessionConfig", () => {
  it("rejects a construction with an empty cwd", () => {
    expect(() => new HuntSessionConfig({ cwd: "" })).toThrow(/must be a non-empty string/);
  });

  it("is equal to a config with the same fields", () => {
    const config = new HuntSessionConfig({ cwd: "/w", configOptions: { model: "opus" } });

    expect(config.isEqualTo(HuntSessionConfig.fromJson(JSON.stringify({ cwd: "/w", configOptions: { model: "opus" } })))).toBe(true);
    expect(config.isEqualTo(new HuntSessionConfig({ cwd: "/w", configOptions: { model: "sonnet" } }))).toBe(false);
  });
});
