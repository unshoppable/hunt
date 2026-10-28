import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyConfigChanges, readHuntSessionConfig, updateConfigFile } from "./hunt-session-config.utils.ts";

describe("readHuntSessionConfig", () => {
  it("names the file in the error", () => {
    expect(() => readHuntSessionConfig("/nonexistent/hunt-session.json")).toThrow(/^failed to read \/nonexistent\/hunt-session\.json: /);
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
