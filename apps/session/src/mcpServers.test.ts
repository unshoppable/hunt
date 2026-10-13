import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMcpServers } from "../relay/config.ts";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("mcp-servers.json", () => {
  it("is a valid server list whose Playwright server runs the package playwright/ pins, where hunt-ctl installs it", () => {
    const [playwright, ...others] = parseMcpServers(read("./mcp-servers.json"));
    const pinned = Object.keys((JSON.parse(read("./playwright/package.json")) as { dependencies: Record<string, string> }).dependencies);

    expect(others).toEqual([]);
    expect(pinned).toEqual(["@playwright/mcp"]);
    expect(playwright.command).toBe("/opt/hunt/node/bin/node");
    expect(playwright.args[0]).toBe("/opt/hunt/agent/playwright/node_modules/@playwright/mcp/cli.js");
    expect(playwright.env).toEqual([{ name: "PLAYWRIGHT_BROWSERS_PATH", value: "/opt/hunt/agent/playwright/browsers" }]);
  });
});
