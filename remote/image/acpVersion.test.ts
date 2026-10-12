import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageLock {
  packages: Record<string, { version?: string }>;
}

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("acp-version", () => {
  it("pins the claude-agent-acp version of Hunt's package-lock.json, which the relay's protocol handling is built for", () => {
    const lock = JSON.parse(read("../../package-lock.json")) as PackageLock;
    const locked = lock.packages["node_modules/@agentclientprotocol/claude-agent-acp"]?.version;
    expect(locked).toBeDefined();
    expect(read("./acp-version").trim()).toBe(locked);
  });
});
