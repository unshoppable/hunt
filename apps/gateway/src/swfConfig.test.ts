import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSwfConfig, readSwfConfig } from "./swfConfig.ts";

const CLI = fileURLToPath(new URL("./swfConfig.ts", import.meta.url));

describe("parseSwfConfig", () => {
  it("fills in the defaults and deduplicates the repositories without case", () => {
    expect(parseSwfConfig({ repos: [" acme/app ", "Acme/App", "acme/api"] })).toEqual({
      config: { repos: ["acme/app", "acme/api"], maxSessions: 2, label: "swf", template: "tpl-hunt-session", machineType: null },
    });
    expect(parseSwfConfig({})).toEqual({ config: { repos: [], maxSessions: 2, label: "swf", template: "tpl-hunt-session", machineType: null } });
    expect(parseSwfConfig({ repos: [], maxSessions: 0, label: "ai-ready", template: "tpl-x", machineType: "e2-standard-8" }).config).toEqual({
      repos: [],
      maxSessions: 0,
      label: "ai-ready",
      template: "tpl-x",
      machineType: "e2-standard-8",
    });
    expect(parseSwfConfig({ machineType: "" }).config?.machineType).toBeNull();
  });

  it("lists every problem", () => {
    expect(parseSwfConfig({ repos: ["acme", "../etc/passwd", 3], maxSessions: 11, label: "Swf Label", template: "Tpl", machineType: "e2 standard" })).toEqual({
      problems: [
        'repos[0]: "acme" is no <owner>/<repo>',
        'repos[1]: "../etc/passwd" is no <owner>/<repo>',
        "repos[2]: 3 is no <owner>/<repo>",
        "maxSessions: must be a whole number from 0 to 10",
        "label: must be 1 to 40 lowercase letters, digits, ':', '_' or '-'",
        "template: must be a Compute Engine name",
        "machineType: must be a Compute Engine name or null",
      ],
    });
    expect(parseSwfConfig({ repos: "acme/app" }).problems).toEqual(["repos: must be a list of <owner>/<repo>"]);
    expect(parseSwfConfig({ maxSessions: 1.5 }).problems).toEqual(["maxSessions: must be a whole number from 0 to 10"]);
    expect(parseSwfConfig([]).problems).toEqual(["the configuration must be a JSON object"]);
  });
});

describe("readSwfConfig", () => {
  it("reads null without a file and fails for an invalid one", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunt-swf-config-"));
    try {
      const path = join(dir, "swf.json");
      expect(readSwfConfig(path)).toBeNull();
      writeFileSync(path, JSON.stringify({ repos: ["acme/app"], maxSessions: 1 }));
      expect(readSwfConfig(path)).toMatchObject({ repos: ["acme/app"], maxSessions: 1 });
      writeFileSync(path, "{");
      expect(() => readSwfConfig(path)).toThrow(`failed to read ${path}`);
      writeFileSync(path, JSON.stringify({ maxSessions: -1 }));
      expect(() => readSwfConfig(path)).toThrow("maxSessions: must be a whole number from 0 to 10");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("swfConfig.ts --validate", () => {
  function validate(input: string) {
    const result = spawnSync(process.execPath, [CLI, "--validate"], { input, encoding: "utf8" });
    return { status: result.status, output: JSON.parse(result.stdout) as unknown };
  }

  it("prints the normalized configuration, or the problems with exit status 1", () => {
    expect(validate(JSON.stringify({ repos: ["acme/app"], maxSessions: 3, label: "swf", template: "tpl-hunt-session", machineType: null }))).toEqual({
      status: 0,
      output: { repos: ["acme/app"], maxSessions: 3, label: "swf", template: "tpl-hunt-session", machineType: null },
    });
    expect(validate(JSON.stringify({ repos: ["nope"] }))).toEqual({ status: 1, output: { ok: false, problems: ['repos[0]: "nope" is no <owner>/<repo>'] } });
    expect(validate("not json").status).toBe(1);
  });
});
