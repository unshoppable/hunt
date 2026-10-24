import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMcpServers } from "./relay/config.ts";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("mcp-servers.json", () => {
  it("is a valid server list whose Playwright server runs the package playwright/ pins, where hunt-ctl installs it, against the desktop's Chromium", () => {
    const [playwright, ...others] = parseMcpServers(read("../mcp-servers.json"));
    const pinned = Object.keys((JSON.parse(read("../playwright/package.json")) as { dependencies: Record<string, string> }).dependencies);

    expect(others).toEqual([]);
    expect(pinned).toEqual(["@playwright/mcp"]);
    expect(playwright.command).toBe("/opt/hunt/node/bin/node");
    expect(playwright.args).toEqual([
      "/opt/hunt/agent/playwright/node_modules/@playwright/mcp/cli.js",
      "--cdp-endpoint",
      "http://127.0.0.1:9222",
      "--output-dir",
      "/tmp/playwright-mcp",
    ]);
    expect(playwright.env).toEqual([]);
  });

  it("pins the same @playwright/mcp as the root package.json, from which local sessions run it", () => {
    const dependenciesOf = (relativePath: string) => (JSON.parse(read(relativePath)) as { dependencies: Record<string, string> }).dependencies;

    expect(dependenciesOf("../playwright/package.json")["@playwright/mcp"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dependenciesOf("../../../package.json")["@playwright/mcp"]).toBe(dependenciesOf("../playwright/package.json")["@playwright/mcp"]);
  });
});
