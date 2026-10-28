import { describe, expect, it } from "vitest";
import { parseMcpServers, readMcpServers } from "./mcp-servers.utils.ts";

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
