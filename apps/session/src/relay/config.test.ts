import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyConfigChanges, DEFAULT_MODE_ID, parseConfig, parseMcpServers, readConfig, readMcpServers, updateConfigFile } from "./config.ts";

describe("parseConfig", () => {
  it("reads every field", () => {
    const text = JSON.stringify({
      huntSessionId: "7c0c6f2e",
      acpSessionId: "acp-1",
      cwd: "/srv/worktrees/7c0c6f2e",
      systemPromptAppend: "Commit locally only.",
      modeId: "acceptEdits",
      configOptions: { model: "opus", effort: "high" },
    });

    expect(parseConfig(text)).toEqual({
      acpSessionId: "acp-1",
      cwd: "/srv/worktrees/7c0c6f2e",
      systemPromptAppend: "Commit locally only.",
      modeId: "acceptEdits",
      configOptions: { model: "opus", effort: "high" },
    });
  });

  it("fills in the defaults and reads a null or empty acpSessionId as a new session", () => {
    const expected = { acpSessionId: null, cwd: "/w", systemPromptAppend: "", modeId: DEFAULT_MODE_ID, configOptions: {} };

    expect(parseConfig(JSON.stringify({ cwd: "/w" }))).toEqual(expected);
    expect(parseConfig(JSON.stringify({ cwd: "/w", acpSessionId: null, modeId: "" }))).toEqual(expected);
    expect(parseConfig(JSON.stringify({ cwd: "/w", acpSessionId: "" }))).toEqual(expected);
  });

  it("rejects a file without a cwd or with values of the wrong type", () => {
    expect(() => parseConfig("[]")).toThrow("expected a JSON object");
    expect(() => parseConfig(JSON.stringify({ acpSessionId: "acp-1" }))).toThrow("cwd must be a non-empty string");
    expect(() => parseConfig(JSON.stringify({ cwd: "/w", acpSessionId: 7 }))).toThrow("acpSessionId must be a string or null");
    expect(() => parseConfig(JSON.stringify({ cwd: "/w", configOptions: ["opus"] }))).toThrow("configOptions must be an object");
    expect(() => parseConfig(JSON.stringify({ cwd: "/w", configOptions: { fast: true } }))).toThrow("configOptions.fast must be a string");
  });
});

describe("readConfig", () => {
  it("names the file in the error", () => {
    expect(() => readConfig("/nonexistent/hunt-session.json")).toThrow(/^failed to read \/nonexistent\/hunt-session\.json: /);
  });
});

describe("applyConfigChanges", () => {
  it("sets the changed fields, merges config options and keeps fields the relay does not know", () => {
    const stored = { huntSessionId: "7c0c6f2e", acpSessionId: null, cwd: "/w", modeId: "bypassPermissions", configOptions: { model: "opus", effort: "high" } };

    expect(applyConfigChanges(stored, { acpSessionId: "acp-2", modeId: "plan", configOptions: { effort: "low" } })).toEqual({
      huntSessionId: "7c0c6f2e",
      acpSessionId: "acp-2",
      cwd: "/w",
      modeId: "plan",
      configOptions: { model: "opus", effort: "low" },
    });
    expect(applyConfigChanges({ cwd: "/w" }, { configOptions: { model: "opus" } })).toEqual({ cwd: "/w", configOptions: { model: "opus" } });
  });
});

describe("updateConfigFile", () => {
  let dir = "";

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies the changes to the file as it is now and leaves no temporary file behind", () => {
    dir = mkdtempSync(join(tmpdir(), "hunt-config-"));
    const path = join(dir, "hunt-session.json");
    writeFileSync(path, JSON.stringify({ huntSessionId: "7c0c6f2e", acpSessionId: null, cwd: "/w", configOptions: { model: "opus" } }));

    updateConfigFile(path, { acpSessionId: "acp-2" });
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), systemPromptAppend: "edited by another writer" }));
    updateConfigFile(path, { configOptions: { effort: "high" } });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      huntSessionId: "7c0c6f2e",
      acpSessionId: "acp-2",
      cwd: "/w",
      configOptions: { model: "opus", effort: "high" },
      systemPromptAppend: "edited by another writer",
    });
    expect(readdirSync(dir)).toEqual(["hunt-session.json"]);
  });
});

describe("parseMcpServers", () => {
  it("reads stdio entries and fills in empty args and env", () => {
    const text = JSON.stringify([
      { name: "playwright", command: "/opt/hunt/node/bin/node", args: ["cli.js", "--headless"], env: [{ name: "A", value: "1" }] },
      { name: "other", command: "/usr/bin/other" },
    ]);

    expect(parseMcpServers(text)).toEqual([
      { name: "playwright", command: "/opt/hunt/node/bin/node", args: ["cli.js", "--headless"], env: [{ name: "A", value: "1" }] },
      { name: "other", command: "/usr/bin/other", args: [], env: [] },
    ]);
  });

  it("rejects what is not a list of stdio entries", () => {
    expect(() => parseMcpServers("{}")).toThrow("expected a JSON array");
    expect(() => parseMcpServers(JSON.stringify([{ name: "x", command: "node" }]))).toThrow("[0].command must be an absolute path");
    expect(() => parseMcpServers(JSON.stringify([{ name: "", command: "/x" }]))).toThrow("[0].name must be a non-empty string");
    expect(() => parseMcpServers(JSON.stringify([{ name: "x", command: "/x", args: [1] }]))).toThrow("[0].args must be an array of strings");
    expect(() => parseMcpServers(JSON.stringify([{ name: "x", command: "/x", env: { A: "1" } }]))).toThrow("[0].env must be an array");
  });
});

describe("readMcpServers", () => {
  it("lists none without a path and names the file when it cannot be read", () => {
    expect(readMcpServers(undefined)).toEqual([]);
    expect(() => readMcpServers("/nonexistent/mcp-servers.json")).toThrow("failed to read /nonexistent/mcp-servers.json");
  });
});
