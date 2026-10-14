import { describe, expect, it } from "vitest";
import { parseSwfConfig, readSwfConfig } from "./swfConfig.ts";

describe("parseSwfConfig", () => {
  it("fills in the defaults, skips empty entries and deduplicates the repositories without case", () => {
    expect(parseSwfConfig(" acme/app , Acme/App,acme/api,", null)).toEqual({ config: { repos: ["acme/app", "acme/api"], maxSessions: 2 } });
    expect(parseSwfConfig(null, null)).toEqual({ config: { repos: [], maxSessions: 2 } });
    expect(parseSwfConfig("", " ")).toEqual({ config: { repos: [], maxSessions: 2 } });
    expect(parseSwfConfig("acme/app", "0").config).toEqual({ repos: ["acme/app"], maxSessions: 0 });
    expect(parseSwfConfig("acme/app", " 10\n").config).toEqual({ repos: ["acme/app"], maxSessions: 10 });
  });

  it("lists every problem", () => {
    expect(parseSwfConfig("acme,../etc/passwd,acme/app", "11")).toEqual({
      problems: [
        'hunt-swf-repos: "acme" is no <owner>/<repo>',
        'hunt-swf-repos: "../etc/passwd" is no <owner>/<repo>',
        'hunt-swf-max-sessions: "11" is no whole number from 0 to 10',
      ],
    });
    for (const value of ["-1", "1.5", "two", "1e1"]) {
      expect(parseSwfConfig(null, value).problems, value).toEqual([`hunt-swf-max-sessions: ${JSON.stringify(value)} is no whole number from 0 to 10`]);
    }
  });
});

describe("readSwfConfig", () => {
  it("reads the attributes at every call and fails for invalid ones", async () => {
    const attributes: Record<string, string> = {};
    const metadata = { attribute: async (key: string) => attributes[key] ?? null };
    expect(await readSwfConfig(metadata)).toEqual({ repos: [], maxSessions: 2 });
    attributes["hunt-swf-repos"] = "medconomy/app-framework,medconomy/infrastructure";
    attributes["hunt-swf-max-sessions"] = "4";
    expect(await readSwfConfig(metadata)).toEqual({ repos: ["medconomy/app-framework", "medconomy/infrastructure"], maxSessions: 4 });
    attributes["hunt-swf-max-sessions"] = "-1";
    await expect(readSwfConfig(metadata)).rejects.toThrow('invalid instance metadata: hunt-swf-max-sessions: "-1" is no whole number from 0 to 10');
  });
});
